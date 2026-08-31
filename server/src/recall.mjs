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
