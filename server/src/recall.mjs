/**
 * Penyusunan briefing recall, dipakai dua pemanggil:
 *
 *   - endpoint `GET /brief`, untuk SessionStart hook  -> buildBrief
 *   - tool MCP `memory_recall`, untuk permintaan detail -> buildRecall
 */

/**
 * Briefing untuk SessionStart hook: bentuk LENGKAP, dibatasi anggaran byte.
 *
 * Dua kegagalan yang sudah terukur membentuk desain ini.
 *
 * Pertama, briefing tanpa batas (18,9 KB) dipotong harness menjadi pratinjau
 * beberapa KB pertama, sisanya dibuang ke file yang tidak dibaca model — recall
 * tampak berhasil padahal separuh isinya hilang.
 *
 * Kedua, versi indeks-saja (judul + satu baris) memaksa model memanggil
 * `memory_recall` untuk mengambil detail. Tambahan round trip itu membuat sesi
 * dengan memory justru LEBIH lambat dan LEBIH mahal daripada tanpa memory:
 * 194 detik vs 101 detik, dan input 1,47 juta vs 1,03 juta token pada uji
 * 2026-08-31.
 *
 * Jadi isi penuh masuk langsung ke konteks, dipotong pada batas ENTRI — bukan
 * di tengah kalimat — dan entri yang tidak kebagian anggaran tetap muncul
 * sebagai judul, dengan jumlahnya disebutkan supaya model tahu ada sisa.
 */
export function buildBrief(db, { repo, branch, inheritFrom = [], budget = 6000 }) {
  // Porsi per entri sengaja pendek. Alternatifnya — entri panjang tapi separuh
  // koleksi jadi judul saja — mengembalikan masalah yang mau dihindari: model
  // memanggil `memory_recall` untuk yang tersisa, dan round trip itulah yang
  // membuat sesi bermemory lebih mahal daripada tanpa memory.
  const BODY_MAX = 400;
  const WHY_MAX = 170;
  const clamp = (v, max) => {
    const flat = String(v ?? '').replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  };

  const cols = 'branch,type,title,body,why,confidence';
  const shared = db
    .prepare(`SELECT ${cols} FROM entries WHERE repo=? AND scope='shared' ORDER BY type, title`)
    .all(repo);
  const branches = [branch, ...inheritFrom].filter(Boolean);
  const ph = branches.map(() => '?').join(',');
  const scoped = branches.length
    ? db
        .prepare(
          `SELECT ${cols} FROM entries WHERE repo=? AND scope='branch' AND branch IN (${ph}) ORDER BY branch, title`,
        )
        .all(repo, ...branches)
    : [];
  const adrs = db.prepare('SELECT number,status,title,decision FROM adrs WHERE repo=? ORDER BY number').all(repo);
  const lineage = db.prepare('SELECT * FROM lineage WHERE repo=? AND branch=?').get(repo, branch);

  if (!shared.length && !scoped.length && !adrs.length) return { empty: true, text: '' };

  // ADR dan lineage selalu masuk: pendek, dan justru bagian yang paling
  // mengikat pekerjaan berikutnya. Anggaran sisanya untuk entri.
  const tail = [];
  if (adrs.length) {
    const lines = adrs
      .map(
        (a) =>
          `- **ADR-${String(a.number).padStart(4, '0')}** [${a.status}] ${a.title} — ${clamp(a.decision, 160)}`,
      )
      .join('\n');
    tail.push(`## Keputusan mengikat (${adrs.length} ADR)\n${lines}`);
  }
  if (lineage) {
    const note = lineage.note ? ' · ada koreksi tercatat' : '';
    tail.push(
      `## Lineage\ninduk: ${lineage.parent_branch ?? '?'} · fork: ${(lineage.fork_point ?? '?').slice(0, 10)}${note}`,
    );
  }
  const tailText = tail.join('\n\n');

  const full = (e) => {
    const flags = [
      e.type,
      e.confidence === 'likely' ? 'belum pasti' : null,
      e.branch && e.branch !== branch ? `dari branch ${e.branch}` : null,
    ]
      .filter(Boolean)
      .join(', ');
    const why = e.why ? `\n**Kenapa penting:** ${clamp(e.why, WHY_MAX)}` : '';
    return `### ${e.title}\n_${flags}_\n${clamp(e.body, BODY_MAX)}${why}`;
  };

  // Branch dulu (paling spesifik untuk pekerjaan saat ini), lalu bersama, lalu
  // warisan — kalau anggaran habis, yang paling umum yang dikorbankan.
  const own = scoped.filter((e) => e.branch === branch);
  const inherited = scoped.filter((e) => e.branch !== branch);
  const ordered = [
    ...own.map((e) => ['Khusus branch ini', e]),
    ...shared.map((e) => ['Berlaku di semua branch', e]),
    ...inherited.map((e) => ['Diwarisi dari branch lain', e]),
  ];

  // Anggaran ditegakkan dengan MERAKIT lalu mengukur, bukan menaksir. Taksiran
  // meleset karena judul bagian, pemisah, dan daftar entri tersisa ikut menambah
  // panjang — versi taksiran menghasilkan 6.283 byte untuk anggaran 6.000.
  const assemble = (take) => {
    const groups = new Map();
    for (const [group, e] of take) {
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(full(e));
    }
    const elided = ordered.slice(take.length).map(([, e]) => e.title);
    const out = [];
    for (const [group, blocks] of groups) {
      out.push(`## ${group} (${blocks.length})\n\n${blocks.join('\n\n')}`);
    }
    if (tailText) out.push(tailText);
    if (elided.length) {
      out.push(
        `## ${elided.length} entri lain, judul saja\n` +
          'Anggaran konteks habis. Ambil isinya dengan `memory_search` bila salah satu relevan:\n' +
          elided.map((t) => `- ${t}`).join('\n'),
      );
    }
    return out.join('\n\n');
  };

  let take = ordered.slice();
  let text = assemble(take);
  while (text.length > budget && take.length > 0) {
    take = take.slice(0, -1);
    text = assemble(take);
  }

  return { empty: false, text };
}

/** Briefing lengkap tanpa batas, untuk tool MCP `memory_recall`. */
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
