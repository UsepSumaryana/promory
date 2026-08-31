/**
 * CLI admin — jalan langsung di VPS, tanpa lewat jaringan.
 *
 * Ini jalan keluar kalau tidak ada admin yang tersisa: token hanya tersimpan
 * sebagai hash, jadi admin yang kehilangan tokennya tidak bisa memulihkan diri
 * lewat GUI. Akses ke shell VPS adalah otoritas terakhir.
 *
 *   node src/admin.mjs list
 *   node src/admin.mjs add <nama> [--admin]
 *   node src/admin.mjs rotate <id>
 *   node src/admin.mjs disable <id>
 *   node src/admin.mjs enable <id>
 */
import { openDb, audit } from './db.mjs';
import { createUser, rotateToken } from './auth.mjs';

const db = openDb(process.env.PM_DB ?? './data/memory.db');
const [cmd, arg] = process.argv.slice(2);
const admin = process.argv.includes('--admin');

const show = (token, name) => {
  console.log(`\nToken untuk ${name}:\n\n  ${token}\n`);
  console.log('Tampil sekali ini saja — token disimpan sebagai hash. Kalau hilang, rotasi.\n');
};

switch (cmd) {
  case 'list': {
    const rows = db.prepare('SELECT id,name,role,created_at,disabled_at,last_seen_at FROM users ORDER BY id').all();
    if (!rows.length) console.log('Belum ada pengguna. Buat admin pertama: node src/admin.mjs add <nama> --admin');
    for (const r of rows)
      console.log(
        `#${r.id}\t${r.role}\t${r.name}\t${r.disabled_at ? 'NONAKTIF' : 'aktif'}\tterakhir: ${r.last_seen_at ?? '-'}`,
      );
    break;
  }
  case 'add': {
    if (!arg) throw new Error('Nama wajib: node src/admin.mjs add <nama> [--admin]');
    show(createUser(db, arg, admin ? 'admin' : 'member', 'cli'), arg);
    break;
  }
  case 'rotate': {
    const token = rotateToken(db, Number(arg), 'cli');
    if (!token) throw new Error(`Pengguna #${arg} tidak ada.`);
    show(token, `#${arg}`);
    break;
  }
  case 'disable':
  case 'enable': {
    const row = db.prepare('SELECT name FROM users WHERE id=?').get(Number(arg));
    if (!row) throw new Error(`Pengguna #${arg} tidak ada.`);
    db.prepare('UPDATE users SET disabled_at=? WHERE id=?').run(cmd === 'disable' ? new Date().toISOString() : null, Number(arg));
    audit(db, 'cli', `${cmd}-user`, null, row.name);
    console.log(`${row.name} ${cmd === 'disable' ? 'dinonaktifkan' : 'diaktifkan'}.`);
    break;
  }
  default:
    console.log('Perintah: list | add <nama> [--admin] | rotate <id> | disable <id> | enable <id>');
}
db.close();
