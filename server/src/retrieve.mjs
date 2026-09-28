/**
 * Retrieval dua tahap, dirancang untuk memory berskala ribuan entri.
 *
 * Tahap 1 — `buildOrientation`, dipanggil SessionStart hook. Pada saat itu
 * pengguna belum mengetik apa pun, jadi relevansi TIDAK BISA dihitung. Yang
 * dikirim karena itu hanya peta: jumlah entri per tipe, ADR yang mengikat,
 * lineage, dan entri ber-`pinned`. Ukurannya tetap kecil berapa pun isi memory.
 *
 * Tahap 2 — `buildRelevant`, dipanggil UserPromptSubmit hook. Di titik ini
 * prompt sudah ada, jadi entri bisa diperingkat dengan BM25 lewat FTS5 dan
 * hanya yang benar-benar cocok yang masuk konteks.
 *
 * Pemisahan ini menjawab kegagalan versi sebelumnya: briefing yang mengirim
 * SEMUA entri terpaksa dipotong sewenang-wenang secara alfabetis begitu
 * anggaran habis, dan pada ribuan entri hal itu tidak bisa dipertahankan.
 *
 * Subagent — `buildSubagentBrief`, dipanggil SubagentStart hook. Subagent tidak
 * melewati kedua tahap di atas, jadi ia menerima orientasi ditambah entri yang
 * sudah lolos tahap 2 untuk agent induknya.
 */

import { ageFlags } from './age.mjs';

const clamp = (v, max) => {
  const flat = String(v ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/**
 * Satu entri dalam bentuk yang disuntikkan ke konteks. Dipakai /relevant dan
 * briefing subagent, supaya entri yang sama terbaca sama di mana pun ia muncul.
 */
function entryBlock(e, branch) {
  // Entri branch didahulukan atas entri bersama pada relevansi setara —
  // konteks branch saat ini lebih mungkin benar untuk pekerjaan sekarang.
  const flags = [
    e.type,
    e.confidence === 'likely' ? 'belum pasti' : null,
    e.branch && e.branch !== branch ? `dari branch ${e.branch}` : null,
    ...ageFlags(e.updated_at),
  ].filter(Boolean);
  return (
    `### ${e.title}\n_${flags.join(', ')}_\n` +
    `${clamp(e.body, 500)}${e.why ? `\n**Kenapa penting:** ${clamp(e.why, 200)}` : ''}`
  );
}

// Kapan pengingat ini ikut ditentukan shouldNudge() di index.mjs.
const REMINDER =
  'Sesi ini sudah berjalan beberapa putaran. Kalau di sepanjangnya ada hal yang MAHAL ' +
  'ditemukan dan tidak jelas dari membaca satu file — alur bispro, keputusan desain beserta ' +
  'alternatif yang ditolak, jebakan yang menghabiskan waktu, konvensi tim, cara menjalankan ' +
  'atau men-debug sesuatu, keputusan non-teknikal dari pengguna — simpan sekarang dengan skill ' +
  '`/project-memory:simpan-memory`. Tulis langsung tanpa menunggu konfirmasi pengguna, lalu ' +
  'laporkan singkat apa yang disimpan. Jangan menyimpan hal yang gampang di-grep dari kode, ' +
  'dan jangan menyimpan kredensial.';

const STOPWORDS = new Set(
  // Indonesia + Inggris, kata yang mencocokkan hampir semua entri sehingga
  // justru merusak peringkat kalau ikut dicari.
  ('yang di ke dari dan atau untuk pada dengan ini itu apa apakah kenapa mengapa bagaimana ' +
    'saya kamu kita bisa tidak jangan ada adalah akan sudah belum juga saja agar supaya ' +
    'the a an of to in for on with is are was were be been do does did how what why when ' +
    'where which that this it its and or not no can could should would will please help me my')
    .split(/\s+/),
);

/**
 * Prompt manusia bukan query FTS5 yang sah — tanda kutip, tanda hubung, dan
 * tanda baca lain akan memicu syntax error pada MATCH. Jadi prompt dipecah jadi
 * token kata, dibuang stopword-nya, lalu disusun ulang sebagai OR query.
 */
export function promptToFtsQuery(prompt, { maxTerms = 12 } = {}) {
  const terms = String(prompt ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  const unique = [...new Set(terms)].slice(0, maxTerms);
  if (!unique.length) return null;
  // Setiap term diberi wildcard akhiran, jadi "config" ikut menemukan
  // "configuration" dan "migrasi" menemukan "migrasinya".
  //
  // Yang TIDAK dijembatani wildcard: beda bahasa. "reservasi" tidak akan pernah
  // menemukan "reservation", karena keduanya berbeda sejak karakter keenam.
  // Entri yang ditulis dalam bahasa Inggris karena itu perlu memuat istilah
  // Indonesianya di judul atau isi bila memang ingin ditemukan lewat pertanyaan
  // berbahasa Indonesia — dan sebaliknya.
  return unique.map((t) => `"${t}"*`).join(' OR ');
}

export function buildOrientation(db, { repo, branch, inheritFrom = [], maxAdr = 25, forSubagent = false }) {
  const counts = db
    .prepare(
      `SELECT type, COUNT(*) AS n FROM entries WHERE repo=? GROUP BY type ORDER BY n DESC`,
    )
    .all(repo);
  const total = counts.reduce((a, c) => a + c.n, 0);
  if (!total) {
    const anyAdr = db.prepare('SELECT COUNT(*) AS n FROM adrs WHERE repo=?').get(repo).n;
    if (!anyAdr) return { empty: true, text: '' };
  }

  const branches = [branch, ...inheritFrom].filter(Boolean);
  const ph = branches.map(() => '?').join(',') || "''";
  const pinned = db
    .prepare(
      `SELECT title, type, body, why, confidence, branch, updated_at FROM entries
        WHERE repo=? AND pinned=1 AND (scope='shared' OR branch IN (${ph}))
        ORDER BY type, title`,
    )
    .all(repo, ...branches);

  const adrs = db
    .prepare("SELECT number,status,title,decision FROM adrs WHERE repo=? AND status LIKE 'accepted%' ORDER BY number LIMIT ?")
    .all(repo, maxAdr);
  const adrTotal = db.prepare('SELECT COUNT(*) AS n FROM adrs WHERE repo=?').get(repo).n;
  const lineage = db.prepare('SELECT * FROM lineage WHERE repo=? AND branch=?').get(repo, branch);

  const out = [];
  if (total) {
    out.push(
      `Memory tim untuk repo ini berisi **${total} entri**: ` +
        counts.map((c) => `${c.n} ${c.type}`).join(', ') +
        // Pernyataan "sudah ada di konteksmu" cukup sekali, dan tempatnya di
        // pembungkus hook. Mengulanginya di sini hanya menghabiskan konteks.
        //
        // Subagent tidak pernah menerima suntikan per permintaan, jadi janji
        // itu tidak boleh ikut ke sana.
        (forSubagent
          ? '.\nSubagent tidak menerima suntikan per permintaan; pakai `memory_search` bila butuh ' +
            'entri yang tidak ada di sini.'
          : '.\nEntri yang relevan akan disuntikkan otomatis begitu pengguna mengirim permintaan. ' +
            'Pakai `memory_search` hanya bila butuh menelusuri sendiri.'),
    );
  }

  if (pinned.length) {
    out.push(
      `## Selalu berlaku (${pinned.length})\n\n` +
        pinned
          .map(
            (e) =>
              `### ${e.title}\n_${[e.type, e.confidence === 'likely' ? 'belum pasti' : null, e.branch ? `branch ${e.branch}` : null, ...ageFlags(e.updated_at)].filter(Boolean).join(', ')}_\n${clamp(e.body, 500)}${e.why ? `\n**Kenapa penting:** ${clamp(e.why, 200)}` : ''}`,
          )
          .join('\n\n'),
    );
  }

  if (adrs.length) {
    const more = adrTotal > adrs.length ? `\n_(${adrTotal - adrs.length} ADR lain tidak ditampilkan — lihat lewat adr_list)_` : '';
    out.push(
      `## Keputusan mengikat (${adrs.length}${adrTotal > adrs.length ? ` dari ${adrTotal}` : ''} ADR)\n` +
        adrs
          .map(
            (a) => `- **ADR-${String(a.number).padStart(4, '0')}** ${a.title} — ${clamp(a.decision, 150)}`,
          )
          .join('\n') +
        more,
    );
  }

  if (lineage) {
    out.push(
      `## Lineage\ninduk: ${lineage.parent_branch ?? '?'} · fork: ${(lineage.fork_point ?? '?').slice(0, 10)}${lineage.note ? ' · ada koreksi tercatat' : ''}`,
    );
  }

  return { empty: !out.length, text: out.join('\n\n') };
}

/**
 * Entri paling relevan dengan sebuah prompt, sudah dikurangi yang pernah
 * dikirim di sesi ini.
 *
 * `exclude` penting: UserPromptSubmit berjalan pada SETIAP pesan, jadi tanpa
 * penyaringan ini entri yang sama disuntikkan berulang dan biayanya justru
 * melebihi mengirim semuanya sekali.
 */
export function buildRelevant(
  db,
  { repo, branch, inheritFrom = [], prompt, exclude = new Set(), budget = 3000, limit = 4, nudge = false },
) {
  // Sesi yang promptnya tidak pernah cocok dengan entri mana pun tetap perlu
  // diingatkan menyimpan — justru sesi seperti itulah yang paling mungkin
  // menghasilkan temuan baru, karena memory belum menutupi topiknya.
  //
  // Karena itu SETIAP jalur keluar tanpa entri membawa pengingatnya. Versi
  // sebelumnya keluar lebih dulu untuk prompt tanpa kata yang bisa dicari
  // ("ok", "ya"), padahal hitungan prompt sudah naik: giliran pengingat itu
  // hilang dan baru datang lagi tiga prompt kemudian.
  const none = { ids: [], text: nudge ? REMINDER : '' };

  const query = promptToFtsQuery(prompt);
  if (!query) return none;

  const branches = [branch, ...inheritFrom].filter(Boolean);
  const ph = branches.map(() => '?').join(',') || "''";

  let rows;
  try {
    rows = db
      .prepare(
        `SELECT e.id, e.title, e.type, e.body, e.why, e.confidence, e.branch, e.scope, e.updated_at,
                bm25(entries_fts) AS rank
           FROM entries_fts
           JOIN entries e ON e.id = entries_fts.rowid
          WHERE entries_fts MATCH ?
            AND e.repo = ?
            AND (e.scope='shared' OR e.branch IN (${ph}))
          ORDER BY rank
          LIMIT ?`,
      )
      .all(query, repo, ...branches, limit * 4);
  } catch {
    // Query FTS yang tetap tidak sah tidak boleh menggagalkan prompt pengguna.
    return none;
  }

  // Query OR mencocokkan entri yang hanya kena satu kata umum, dan tanpa ambang
  // hasilnya penuh kebisingan: permintaan soal `maxIdle` ikut menarik entri
  // tentang alur order hanya karena kata "koneksi" dan "nilai". BM25 di SQLite
  // bernilai negatif — makin negatif makin relevan — jadi entri dipertahankan
  // hanya bila skornya masih dalam rasio tertentu dari yang terbaik.
  // Ambang dihitung terhadap skor terbaik dari SELURUH hasil, termasuk yang
  // sudah pernah dikirim di sesi ini.
  //
  // Versi pertama menghitungnya setelah dedup, dan itu salah: entri teratas
  // selalu lolos ambangnya sendiri (untuk skor negatif, best <= best*0,55
  // selalu benar), jadi begitu kandidat terkuat tersaring karena sudah dikirim,
  // kandidat kedua naik menjadi "terbaik" dan lolos tanpa benar-benar relevan.
  // Akibatnya prompt lanjutan tentang topik yang sudah dijawab justru
  // menyuntikkan tiga entri tak berkaitan — terjadi pada 2026-08-31.
  //
  // Dengan patokan dari hasil penuh, entri yang tersisa harus benar-benar
  // sekuat kandidat terkuat untuk ikut. Kalau tidak, hook diam — dan diam
  // adalah jawaban yang benar ketika topiknya sudah dibahas.
  const RATIO = 0.55;
  const bestOverall = rows.length ? rows[0].rank : 0;
  const relevant = rows.filter((e) => !exclude.has(e.id) && e.rank <= bestOverall * RATIO);

  const picked = [];
  const ids = [];
  let used = 0;
  for (const e of relevant) {
    const block = entryBlock(e, branch);
    if (used + block.length > budget) break;
    picked.push(block);
    ids.push(e.id);
    used += block.length + 2;
    if (picked.length >= limit) break;
  }

  if (!picked.length) return none;

  const text =
    `# Memory relevan (${picked.length} entri)\n\n` +
    'Entri di bawah **SUDAH ADA di konteksmu**, disuntikkan otomatis oleh plugin project-memory ' +
    'berdasarkan permintaan pengguna di atas — tanpa pemanggilan tool apa pun. Kalau pengguna ' +
    'bertanya apakah kamu memakai project-memory, jawab YA dan sebut entri yang kamu terima; ' +
    'jangan menjawab "belum" hanya karena tidak ada tool call.\n\n' +
    'Pakai ini alih-alih mengeksplorasi codebase dari nol; verifikasi ke kode hanya untuk path, ' +
    'nama, atau flag yang akan kamu ubah.\n\n' +
    // Umur entri ikut dicetak di header tiap blok, dan tanpa instruksi ini
    // informasi itu tidak berguna: model akan melihat "5 bulan lalu" lalu tetap
    // memakainya apa adanya. Memory bersama yang salah menyesatkan SEMUA orang,
    // jadi menemukan entri yang sudah tidak benar adalah temuan yang wajib
    // ditindak, bukan sekadar dicatat dalam hati untuk sesi ini saja.
    'Entri bertanda **PERIKSA ULANG** sudah cukup tua untuk mungkin tidak akurat lagi. Kalau isi ' +
    'entri mana pun ternyata bertentangan dengan kode yang kamu baca, jangan diam dan jangan ' +
    'sekadar mengabaikannya: perbaiki entrinya lewat `/project-memory:simpan-memory` dengan judul ' +
    'yang sama persis (judul sama = memperbarui, bukan menumpuk duplikat), atau hapus kalau memang ' +
    'sudah tidak berlaku. Memory ini dibaca seluruh tim, jadi entri salah yang dibiarkan akan ' +
    'menyesatkan orang berikutnya.\n\n' +
    picked.join('\n\n') +
    (nudge ? `\n\n---\n${REMINDER}` : '');

  return { ids, text };
}

/**
 * Briefing untuk subagent, dipanggil SubagentStart hook.
 *
 * Subagent tidak pernah melewati SessionStart maupun UserPromptSubmit, dan input
 * SubagentStart tidak memuat teks tugasnya — jadi relevansi tidak bisa dihitung
 * ulang. Tebakan terbaik yang tersedia adalah entri yang sudah diterima agent
 * induk di sesi ini: entri itu lolos pemeringkatan untuk permintaan pengguna
 * yang sedang dikerjakan, dan tugas subagent hampir selalu potongan dari
 * permintaan itu.
 *
 * `sentIds` datang dalam urutan pengiriman. Yang terbaru didahulukan dan yang
 * tertua dikorbankan lebih dulu bila anggaran habis; orientasi selalu ikut.
 * Entri tidak dicatat ke statistik pemakaian di sini: ia sudah terhitung saat
 * pertama kali lolos /relevant, dan statistik itu mengukur relevansi, bukan
 * berapa banyak konteks yang menyalinnya.
 */
export function buildSubagentBrief(db, { repo, branch, inheritFrom = [], sentIds = [], budget = 4000 }) {
  const orientation = buildOrientation(db, { repo, branch, inheritFrom, forSubagent: true });
  if (orientation.empty) return orientation;

  const ids = [...sentIds].reverse();
  let rows = [];
  if (ids.length) {
    const byId = new Map(
      db
        .prepare(
          `SELECT id, title, type, body, why, confidence, branch, updated_at FROM entries
            WHERE repo=? AND id IN (${ids.map(() => '?').join(',')})`,
        )
        .all(repo, ...ids)
        .map((e) => [e.id, e]),
    );
    rows = ids.map((id) => byId.get(id)).filter(Boolean);
  }

  const assemble = (take) =>
    [
      orientation.text,
      take.length
        ? `## Sudah diterima agent induk di sesi ini (${take.length})\n\n` +
          take.map((e) => entryBlock(e, branch)).join('\n\n')
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');

  // Anggaran ditegakkan dengan merakit lalu mengukur, bukan menaksir — sama
  // seperti buildBrief di recall.mjs.
  let take = rows;
  let text = assemble(take);
  while (text.length > budget && take.length) {
    take = take.slice(0, -1);
    text = assemble(take);
  }
  return { empty: false, text };
}
