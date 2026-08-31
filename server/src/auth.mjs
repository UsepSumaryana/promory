import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { audit } from './db.mjs';

export const hashToken = (token) => createHash('sha256').update(token, 'utf8').digest('hex');
export const mintToken = () => `pm_${randomBytes(24).toString('hex')}`;

/**
 * Pencarian token lewat hash sudah setara-waktu secara efektif (indeks unik atas
 * digest), tapi perbandingan akhir tetap dibuat konstan agar tidak ada jalur
 * yang membocorkan panjang atau prefix lewat selisih waktu.
 */
function sameHash(a, b) {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function authenticate(db, token) {
  if (!token) return null;
  const hash = hashToken(token);
  const row = db.prepare('SELECT * FROM users WHERE token_hash=?').get(hash);
  if (!row || !sameHash(row.token_hash, hash)) return null;
  if (row.disabled_at) return null;
  db.prepare('UPDATE users SET last_seen_at=? WHERE id=?').run(new Date().toISOString(), row.id);
  return { id: row.id, name: row.name, role: row.role };
}

export function createUser(db, name, role, actor) {
  const token = mintToken();
  db.prepare('INSERT INTO users (name, token_hash, role, created_at) VALUES (?,?,?,?)')
    .run(name, hashToken(token), role, new Date().toISOString());
  audit(db, actor, 'create-user', null, `${name} (${role})`);
  return token;
}

export function rotateToken(db, id, actor) {
  const row = db.prepare('SELECT name FROM users WHERE id=?').get(id);
  if (!row) return null;
  const token = mintToken();
  db.prepare('UPDATE users SET token_hash=?, disabled_at=NULL WHERE id=?').run(hashToken(token), id);
  audit(db, actor, 'rotate-token', null, row.name);
  return token;
}

/**
 * Bootstrap sekali jalan dari PM_TOKENS. Hanya berlaku selagi tabel users masih
 * kosong: setelah admin pertama ada, database yang jadi sumber kebenaran dan
 * mengubah PM_TOKENS tidak lagi berpengaruh. Ini mencegah env var lama diam-diam
 * menghidupkan kembali akses yang sudah dicabut lewat GUI.
 */
export function seedFromEnv(db, raw) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return { seeded: 0, skipped: true };
  let seeded = 0;
  for (const pair of (raw ?? '').split(',')) {
    const idx = pair.indexOf(':');
    if (idx < 1) continue;
    const name = pair.slice(0, idx).trim();
    const token = pair.slice(idx + 1).trim();
    if (!name || !token) continue;
    try {
      db.prepare('INSERT INTO users (name, token_hash, role, created_at) VALUES (?,?,?,?)')
        .run(name, hashToken(token), seeded === 0 ? 'admin' : 'member', new Date().toISOString());
      seeded++;
    } catch {
      // nama atau token duplikat di PM_TOKENS — lewati, jangan gagalkan startup
    }
  }
  if (seeded) audit(db, 'system', 'seed-users', null, `${seeded} pengguna dari PM_TOKENS`);
  return { seeded, skipped: false };
}
