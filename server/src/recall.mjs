/**
 * Penyusunan briefing recall, dipakai dua pemanggil:
 *
 *   - tool MCP `memory_recall`, untuk agent yang memang memanggilnya sendiri
 *   - endpoint `GET /brief`, untuk SessionStart hook
 *
 * Jalur hook itu yang penting: sebagian harness Claude Code melarang model
 * memanggil Agent tool tanpa permintaan eksplisit pengguna, sehingga rancangan
 * "hook menyuruh model memanggil subagent" tidak pernah jalan di sana. Hook yang
 * mengambil briefing sendiri lalu mencetaknya ke stdout tidak bergantung pada
 * keputusan model mana pun.
 */
/**
 * Indeks padat untuk SessionStart hook.
 *
 * Briefing lengkap tidak boleh dipakai di sini: hook stdout yang besar dipotong
 * harness menjadi pratinjau beberapa KB pertama, dan sisanya dibuang ke file yang
 * tidak dibaca model. Akibatnya recall tampak berhasil tapi separuh isinya hilang
 * secara acak — pernah terjadi dengan briefing 18,9 KB.
 *
 * Jadi yang disuntikkan hanya judul, tipe, dan satu baris "kenapa penting" tiap
 * entri. Itu cukup bagi model untuk tahu apa yang sudah diketahui tim, dan ia
 * bisa menarik detail lengkapnya lewat `memory_recall` atau `memory_search`
 * ketika memang dibutuhkan.
 */
export function buildBrief(db, { repo, branch, inheritFrom = [] }) {
  const oneLine = (s, max = 90) => {
    const flat = String(s ?? '').replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  };

  const shared = db
    .prepare("SELECT type,title,why,body,confidence FROM entries WHERE repo=? AND scope='shared' ORDER BY type, title")
    .all(repo);
  const branches = [branch, ...inheritFrom].filter(Boolean);
  const ph = branches.map(() => '?').join(',');
  const scoped = branches.length
    ? db
        .prepare(
          `SELECT branch,type,title,why,body,confidence FROM entries WHERE repo=? AND scope='branch' AND branch IN (${ph}) ORDER BY branch, title`,
        )
        .all(repo, ...branches)
    : [];
  const adrs = db.prepare('SELECT number,status,title FROM adrs WHERE repo=? ORDER BY number').all(repo);
  const lineage = db.prepare('SELECT * FROM lineage WHERE repo=? AND branch=?').get(repo, branch);

  if (!shared.length && !scoped.length && !adrs.length) return { empty: true, text: '' };

  const row = (e) =>
    `- **${e.title}** _(${e.type}${e.confidence === 'likely' ? ', belum pasti' : ''}${e.branch && e.branch !== branch ? `, dari ${e.branch}` : ''})_ — ${oneLine(e.why || e.body)}`;

  const out = [];
  if (shared.length) out.push(`**Berlaku di semua branch (${shared.length})**\n${shared.map(row).join('\n')}`);
  const own = scoped.filter((e) => e.branch === branch);
  const inherited = scoped.filter((e) => e.branch !== branch);
  if (own.length) out.push(`**Khusus branch ini (${own.length})**\n${own.map(row).join('\n')}`);
  if (inherited.length) out.push(`**Diwarisi dari branch lain (${inherited.length})**\n${inherited.map(row).join('\n')}`);
  if (adrs.length)
    out.push(
      `**Keputusan mengikat (${adrs.length} ADR)**\n` +
        adrs.map((a) => `- ADR-${String(a.number).padStart(4, '0')} [${a.status}] ${a.title}`).join('\n'),
    );
  if (lineage)
    out.push(
      `**Lineage** — induk: ${lineage.parent_branch ?? '?'}, fork: ${(lineage.fork_point ?? '?').slice(0, 10)}${lineage.note ? ' (ada koreksi tercatat)' : ''}`,
    );

  return { empty: false, text: out.join('\n\n') };
}

export function buildRecall(db, { repo, branch, inheritFrom = [], includeAdr = true }) {
  const shared = db
    .prepare("SELECT * FROM entries WHERE repo=? AND scope='shared' ORDER BY type, title")
    .all(repo);
  const branches = [branch, ...inheritFrom].filter(Boolean);
  const placeholders = branches.map(() => '?').join(',');
  const scoped = branches.length
    ? db
        .prepare(
          `SELECT * FROM entries WHERE repo=? AND scope='branch' AND branch IN (${placeholders}) ORDER BY branch, title`,
        )
        .all(repo, ...branches)
    : [];
  const adrs = includeAdr ? db.prepare('SELECT * FROM adrs WHERE repo=? ORDER BY number').all(repo) : [];
  const lineage = db.prepare('SELECT * FROM lineage WHERE repo=? AND branch=?').get(repo, branch);

  if (!shared.length && !scoped.length && !adrs.length) {
    return {
      empty: true,
      text: `Belum ada memory untuk repo '${repo}'. Jangan mengarang — eksplorasi seperti biasa, lalu simpan temuannya lewat memory_write di akhir tugas.`,
    };
  }

  const fmt = (e) =>
    `### ${e.title}\n[type: ${e.type} | confidence: ${e.confidence} | oleh: ${e.author} | diperbarui: ${e.updated_at.slice(0, 10)}${e.branch ? ` | branch: ${e.branch}` : ''}]\n${e.body}${e.why ? `\nKenapa penting: ${e.why}` : ''}`;

  const out = [];
  if (shared.length) out.push(`## Memory bersama (${shared.length})\n\n${shared.map(fmt).join('\n\n')}`);
  const own = scoped.filter((e) => e.branch === branch);
  const inherited = scoped.filter((e) => e.branch !== branch);
  if (own.length) out.push(`## Branch '${branch}' (${own.length})\n\n${own.map(fmt).join('\n\n')}`);
  if (inherited.length)
    out.push(
      `## Diwarisi dari branch lain (${inherited.length}) — kalah bila bertentangan dengan memory branch saat ini\n\n${inherited.map(fmt).join('\n\n')}`,
    );
  if (adrs.length)
    out.push(
      `## ADR (${adrs.length})\n\n` +
        adrs
          .map(
            (a) =>
              `### ADR-${String(a.number).padStart(4, '0')} — ${a.title}\n[status: ${a.status} | oleh: ${a.author}]\nKonteks: ${a.context}\nKeputusan: ${a.decision}${a.alternatives ? `\nAlternatif ditolak: ${a.alternatives}` : ''}${a.consequences ? `\nKonsekuensi: ${a.consequences}` : ''}`,
          )
          .join('\n\n'),
    );
  if (lineage)
    out.push(
      `## Lineage tercatat\ninduk: ${lineage.parent_branch ?? '?'} | fork: ${lineage.fork_point ?? '?'}\nmerge masuk: ${lineage.merged_in ?? '-'}\nsudah termuat di: ${lineage.contained_by ?? '-'}${lineage.note ? `\ncatatan: ${lineage.note}` : ''}`,
    );

  out.push(
    'Fakta di atas adalah snapshot saat ditulis. Verifikasi ulang apa pun yang menyebut path, fungsi, atau flag sebelum dipakai.',
  );
  return { empty: false, text: out.join('\n\n---\n\n') };
}
