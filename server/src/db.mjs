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
  return db;
}

export function audit(db, author, action, repo, detail) {
  db.prepare('INSERT INTO audit (at, author, action, repo, detail) VALUES (?,?,?,?,?)')
    .run(new Date().toISOString(), author, action, repo ?? null, detail ?? null);
}
