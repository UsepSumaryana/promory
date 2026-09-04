import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Penyimpanan memory. Satu file SQLite: mudah di-backup (salin satu file),
 * atomik, dan aman untuk penulisan bersamaan dengan WAL — beberapa anggota tim
 * menulis dari sesi Claude Code masing-masing pada saat yang sama.
 */
export function openDb(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      repo        TEXT NOT NULL,
      scope       TEXT NOT NULL CHECK (scope IN ('shared','branch')),
      branch      TEXT,
      type        TEXT NOT NULL,
      title       TEXT NOT NULL,
      body        TEXT NOT NULL,
      why         TEXT,
      confidence  TEXT NOT NULL DEFAULT 'confirmed',
      author      TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    -- Judul unik per (repo, scope, branch): menulis judul yang sama berarti
    -- memperbarui entri, bukan menumpuk duplikat. Ini yang menjaga store tetap
    -- ringkas meski banyak orang menulis fakta yang sama.
    CREATE UNIQUE INDEX IF NOT EXISTS entries_key
      ON entries (repo, scope, IFNULL(branch,''), title);
    CREATE INDEX IF NOT EXISTS entries_lookup ON entries (repo, scope, branch);

    CREATE TABLE IF NOT EXISTS adrs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      repo          TEXT NOT NULL,
      number        INTEGER NOT NULL,
      title         TEXT NOT NULL,
      status        TEXT NOT NULL,
      scope         TEXT,
      branch        TEXT,
      context       TEXT NOT NULL,
      decision      TEXT NOT NULL,
      alternatives  TEXT,
      consequences  TEXT,
      supersedes    INTEGER,
      superseded_by INTEGER,
      author        TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS adrs_number ON adrs (repo, number);

    CREATE TABLE IF NOT EXISTS lineage (
      repo          TEXT NOT NULL,
      branch        TEXT NOT NULL,
      parent_branch TEXT,
      fork_point    TEXT,
      merged_in     TEXT,
      contained_by  TEXT,
      note          TEXT,
      author        TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      PRIMARY KEY (repo, branch)
    );

    -- Jejak audit: memory bersama adalah publikasi ke tim, jadi setiap tulis dan
    -- hapus harus bisa ditelusuri siapa dan kapan.
    CREATE TABLE IF NOT EXISTS audit (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      at         TEXT NOT NULL,
      author     TEXT NOT NULL,
      action     TEXT NOT NULL,
      repo       TEXT,
      detail     TEXT
    );

    -- Token disimpan sebagai hash SHA-256, tidak pernah sebagai teks asli.
    -- Konsekuensinya token hanya bisa dilihat sekali saat dibuat; yang hilang
    -- harus dirotasi, tidak bisa dibaca ulang. Itu memang yang diinginkan —
    -- database yang bocor tidak boleh menyerahkan akses semua orang.
    CREATE TABLE IF NOT EXISTS users (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL UNIQUE,
      token_hash   TEXT NOT NULL UNIQUE,
      role         TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
      created_at   TEXT NOT NULL,
      disabled_at  TEXT,
      last_seen_at TEXT
    );
  `);

  // Pemetaan commit root -> slug kanonis. Slug diturunkan dari URL remote di
  // sisi klien dan ternyata bisa berbeda antar-anggota untuk repo yang sama;
  // commit root identik di semua clone, jadi dialah identitas yang dipakai
  // untuk menyatukan.
  db.exec(`
    CREATE TABLE IF NOT EXISTS repo_identity (
      root_commit    TEXT PRIMARY KEY,
      canonical_slug TEXT NOT NULL,
      created_at     TEXT NOT NULL
    );
  `);

  // --- migrasi bertahap, aman dijalankan berulang ---

  // `pinned` menandai entri yang SELALU ikut di briefing awal sesi. Pada skala
  // ribuan entri, briefing tidak mungkin memuat semuanya, jadi harus ada cara
  // menyatakan "yang ini jangan sampai terlewat" tanpa bergantung pada relevansi
  // kata kunci.
  try {
    db.exec('ALTER TABLE entries ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
  } catch {
    // kolom sudah ada — abaikan
  }

  // FTS5 untuk pencarian berbasis relevansi (BM25). Tanpa ini, pencarian memakai
  // LIKE '%kata%' yang memindai seluruh tabel dan tidak punya peringkat — masih
  // memadai untuk belasan entri, tapi tidak untuk ribuan.
  //
  // Memakai external content table: isi tetap di `entries`, FTS hanya menyimpan
  // indeksnya, jadi tidak ada duplikasi teks.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
      title, body, why,
      content='entries',
      content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    );

    CREATE TRIGGER IF NOT EXISTS entries_fts_ins AFTER INSERT ON entries BEGIN
      INSERT INTO entries_fts (rowid, title, body, why) VALUES (new.id, new.title, new.body, new.why);
    END;
    CREATE TRIGGER IF NOT EXISTS entries_fts_del AFTER DELETE ON entries BEGIN
      INSERT INTO entries_fts (entries_fts, rowid, title, body, why) VALUES ('delete', old.id, old.title, old.body, old.why);
    END;
    CREATE TRIGGER IF NOT EXISTS entries_fts_upd AFTER UPDATE ON entries BEGIN
      INSERT INTO entries_fts (entries_fts, rowid, title, body, why) VALUES ('delete', old.id, old.title, old.body, old.why);
      INSERT INTO entries_fts (rowid, title, body, why) VALUES (new.id, new.title, new.body, new.why);
    END;
  `);

  // Backfill untuk database yang sudah berisi sebelum FTS ada. Trigger di atas
  // hanya menangkap perubahan setelah ini, jadi tanpa rebuild entri lama tidak
  // akan pernah muncul di hasil pencarian.
  //
  // Penanda kemajuan disimpan di tabel `meta`, BUKAN dengan menghitung baris
  // entries_fts. Pada FTS5 external content, `COUNT(*) FROM entries_fts`
  // membaca tabel `entries`, jadi selalu sama dengan totalnya — penjaga versi
  // pertama karena itu tidak pernah memicu rebuild dan indeksnya tetap kosong,
  // sementara `MATCH` mengembalikan nol tanpa galat apa pun.
  // Statistik penyuntikan: berapa kali sebuah entri benar-benar sampai ke
  // konteks seseorang, dan kapan terakhir.
  //
  // Tabel `audit` mencatat tulis dan hapus — bukan pemakaian. Akibatnya tiga
  // pertanyaan kurasi yang paling menentukan tidak bisa dijawab sama sekali:
  // entri mana yang TIDAK PERNAH tertarik (beban mati, kandidat hapus), mana
  // yang tertarik terus-menerus (kandidat `pinned`), dan repo mana yang
  // memory-nya sebenarnya tidak pernah aktif. Pada skala ribuan entri, itu
  // bedanya antara store yang tajam dan store yang membengkak sambil semua
  // orang menduga-duga.
  //
  // Bentuknya agregat, bukan satu baris per penyuntikan. Satu baris per entri
  // berarti ukuran tabel dibatasi jumlah entri dan tidak pernah tumbuh sendiri,
  // sementara hits + first_at + last_at sudah cukup menjawab ketiga pertanyaan
  // di atas. Rangkaian waktu penuh akan lebih kaya, tapi harganya tabel yang
  // tumbuh selamanya untuk pertanyaan yang belum ada.
  //
  // ON DELETE CASCADE: entri yang dihapus tidak boleh meninggalkan statistik
  // yatim yang lalu ikut terhitung di ringkasan.
  db.exec(`
    CREATE TABLE IF NOT EXISTS retrieval_stats (
      entry_id INTEGER PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
      hits     INTEGER NOT NULL DEFAULT 0,
      first_at TEXT NOT NULL,
      last_at  TEXT NOT NULL
    );
  `);

  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const FTS_VERSION = '1'; // naikkan bila skema atau tokenizer FTS berubah
  const total = db.prepare('SELECT COUNT(*) AS n FROM entries').get().n;
  const marker = db.prepare("SELECT value FROM meta WHERE key='fts_state'").get()?.value;
  const want = `${FTS_VERSION}:${total}`;
  if (marker !== want) {
    db.exec("INSERT INTO entries_fts (entries_fts) VALUES ('rebuild')");
    db.prepare("INSERT INTO meta (key,value) VALUES ('fts_state',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(want);
  }

  return db;
}

export function audit(db, author, action, repo, detail) {
  db.prepare('INSERT INTO audit (at, author, action, repo, detail) VALUES (?,?,?,?,?)')
    .run(new Date().toISOString(), author, action, repo ?? null, detail ?? null);
}

/**
 * Catat bahwa sekumpulan entri baru disuntikkan ke konteks seseorang.
 *
 * Dipanggil dari jalur `/relevant`, yang berjalan pada SETIAP prompt setiap
 * anggota tim. Dua konsekuensi mengikat desainnya: harus murah (satu UPSERT per
 * entri, dan entri per prompt dibatasi empat), dan TIDAK BOLEH melempar.
 * Kegagalan pencatatan statistik yang menjatuhkan permintaan berarti seluruh tim
 * kehilangan recall demi angka yang sifatnya hanya informatif.
 */
export function recordRetrievals(db, ids = []) {
  if (!ids.length) return;
  const at = new Date().toISOString();
  try {
    const up = db.prepare(`
      INSERT INTO retrieval_stats (entry_id, hits, first_at, last_at) VALUES (?, 1, ?, ?)
      ON CONFLICT(entry_id) DO UPDATE SET hits = hits + 1, last_at = excluded.last_at
    `);
    db.exec('BEGIN');
    try {
      for (const id of ids) up.run(id, at, at);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  } catch (err) {
    console.error('[retrieval-stats]', err?.message ?? err);
  }
}
