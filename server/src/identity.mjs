import { audit } from './db.mjs';

/**
 * Penyatuan identitas repo.
 *
 * Slug diturunkan dari URL remote di sisi klien, dan itu terbukti tidak cukup:
 * dua anggota tim bisa mendapat slug berbeda untuk repo git yang SAMA — satu
 * punya remote lengkap (`reusable/business-service-mini-ticast`), satu jatuh ke
 * nama folder (`business-service-mini-ticast`) karena remote-nya tidak terbaca.
 * Memory keduanya lalu terbelah tanpa ada yang menyadari, dan itu kegagalan
 * paling merugikan dari sistem ini: tujuan utamanya justru menyatukan temuan.
 *
 * Commit root dipakai sebagai identitas kanonis — identik di semua clone,
 * tidak bergantung nama remote, nama folder, maupun ada-tidaknya remote.
 *
 * Slug TETAP dipakai sebagai nama yang terbaca manusia; pemetaan ini hanya
 * memutuskan slug mana yang menang ketika satu repo dikenal dengan dua nama.
 */
export function resolveRepo(db, { slug, rootCommit }) {
  if (!slug) return { repo: slug, merged: false };

  // Klien lama (belum mengirim root), atau clone shallow yang commit root-nya
  // bukan yang asli — pakai slug apa adanya, jangan menebak.
  const root = typeof rootCommit === 'string' ? rootCommit.trim() : '';
  if (!/^[0-9a-f]{40}$/.test(root)) return { repo: slug, merged: false };

  const known = db.prepare('SELECT canonical_slug FROM repo_identity WHERE root_commit=?').get(root);
  if (known) {
    return { repo: known.canonical_slug, merged: known.canonical_slug !== slug };
  }

  // Pertama kali root ini terlihat: slug yang dipakai sekarang jadi kanonis.
  db.prepare(
    'INSERT INTO repo_identity (root_commit, canonical_slug, created_at) VALUES (?,?,?) ' +
      'ON CONFLICT(root_commit) DO NOTHING',
  ).run(root, slug, new Date().toISOString());
  return { repo: slug, merged: false };
}

/**
 * Pindahkan seluruh isi memory satu slug ke slug lain, lalu jadikan tujuan
 * sebagai kanonis untuk commit root yang diberikan.
 *
 * Dipakai untuk membereskan repo yang sudah terbelah sebelum penyatuan identitas
 * ada. Tidak menimpa apa pun: judul yang bentrok dilewati dan dilaporkan, karena
 * menggabungkan dua tulisan berbeda dengan judul sama adalah keputusan manusia.
 */
export function mergeRepo(db, { from, to, rootCommit, actor = 'cli' }) {
  const report = { movedEntries: 0, skippedEntries: [], movedAdrs: 0, movedLineage: 0 };

  const entries = db.prepare('SELECT * FROM entries WHERE repo=?').all(from);
  const moveEntry = db.prepare('UPDATE entries SET repo=? WHERE id=?');
  const clash = db.prepare(
    "SELECT id FROM entries WHERE repo=? AND scope=? AND IFNULL(branch,'')=IFNULL(?,'') AND title=?",
  );
  for (const e of entries) {
    if (clash.get(to, e.scope, e.branch, e.title)) {
      report.skippedEntries.push(e.title);
      continue;
    }
    moveEntry.run(to, e.id);
    report.movedEntries++;
  }

  // Nomor ADR unik per repo, jadi yang dipindah harus dinomori ulang di tujuan.
  const adrs = db.prepare('SELECT * FROM adrs WHERE repo=? ORDER BY number').all(from);
  for (const a of adrs) {
    const max = db.prepare('SELECT MAX(number) AS n FROM adrs WHERE repo=?').get(to)?.n ?? 0;
    db.prepare('UPDATE adrs SET repo=?, number=? WHERE id=?').run(to, max + 1, a.id);
    report.movedAdrs++;
  }

  const lineages = db.prepare('SELECT * FROM lineage WHERE repo=?').all(from);
  for (const l of lineages) {
    const exists = db.prepare('SELECT 1 AS x FROM lineage WHERE repo=? AND branch=?').get(to, l.branch);
    if (exists) {
      db.prepare('DELETE FROM lineage WHERE repo=? AND branch=?').run(from, l.branch);
    } else {
      db.prepare('UPDATE lineage SET repo=? WHERE repo=? AND branch=?').run(to, from, l.branch);
      report.movedLineage++;
    }
  }

  if (rootCommit && /^[0-9a-f]{40}$/.test(rootCommit)) {
    db.prepare(
      'INSERT INTO repo_identity (root_commit, canonical_slug, created_at) VALUES (?,?,?) ' +
        'ON CONFLICT(root_commit) DO UPDATE SET canonical_slug=excluded.canonical_slug',
    ).run(rootCommit, to, new Date().toISOString());
  }

  audit(
    db,
    actor,
    'merge-repo',
    to,
    `dari '${from}': ${report.movedEntries} entri, ${report.movedAdrs} ADR, ${report.movedLineage} lineage` +
      (report.skippedEntries.length ? `; ${report.skippedEntries.length} judul bentrok dilewati` : ''),
  );
  return report;
}
