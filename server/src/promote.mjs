/**
 * Promosi entri branch yang pekerjaannya sudah ter-merge.
 *
 * pm-context.sh sudah menghitung `contained_by` — daftar branch lain yang HEAD
 * branch ini menjadi ancestor-nya, yaitu bukti bahwa seluruh isi branch ini
 * sudah masuk ke sana. Perhitungan itu berharga 1,1 detik setiap pemanggilan,
 * lalu hasilnya hanya dicetak dan tidak pernah dipakai untuk apa pun.
 *
 * Konsekuensinya nyata: entri ber-`scope=branch` pada branch yang sudah
 * di-merge lalu branch-nya dihapus menjadi orphan. Entri itu masih ada di
 * database, tapi tidak pernah lolos filter `branch IN (...)` milik siapa pun
 * lagi — jadi tidak muncul di recall, tidak muncul di briefing, dan tidak ada
 * yang tahu bahwa pengetahuannya hilang. Ini justru mengenai entri yang paling
 * berharga: temuan yang lahir saat mengerjakan fitur, di branch fitur itu.
 *
 * Promosi mengubah scope ke `shared` sehingga entri berlaku di semua branch.
 */

/**
 * Branch mana di `contained_by` yang benar-benar merupakan bukti merge.
 *
 * Penyaringan ini wajib. Loop `contained_by` di pm-context.sh hanya melewatkan
 * nama branch itu sendiri, BUKAN ref pelacak remote-nya. Jadi branch yang baru
 * di-push — belum di-merge ke mana pun — tetap melaporkan `origin/<branch>` di
 * daftarnya. Tanpa filter, setiap branch yang pernah di-push akan langsung
 * dianggap sudah ter-merge dan entri branch-nya dipromosikan terlalu dini.
 *
 * Batasnya: nama remote tidak diketahui dari sisi server, jadi yang dipakai
 * adalah bentuknya — `<apa pun>/<nama branch ini>`. Branch bernama `main` yang
 * benar-benar termuat di branch bernama `release/main` karena itu ikut tersaring
 * dan tidak dipromosikan otomatis. Kehilangan itu disengaja: gagal dengan tidak
 * berbuat apa-apa jauh lebih baik daripada mempromosikan entri branch terlalu
 * dini ke seluruh tim.
 */
export function mergeTargets(branch, containedBy = []) {
  return containedBy
    .map((s) => String(s ?? '').trim())
    .filter(Boolean)
    .filter((b) => b !== branch)
    .filter((b) => {
      const slash = b.indexOf('/');
      return slash < 0 || b.slice(slash + 1) !== branch;
    });
}

/**
 * Pindahkan entri `scope=branch` milik `branch` menjadi `shared`.
 *
 * Yang TIDAK dilakukan, dan sengaja:
 *
 *   - `updated_at` tidak disentuh. Promosi adalah perubahan scope, bukan
 *     peninjauan isi. Menaikkannya akan membuat entri berumur setahun tampak
 *     baru dan menghapus penanda "PERIKSA ULANG" yang justru paling relevan
 *     untuk entri lama.
 *   - Entri yang judulnya bertabrakan dengan entri `shared` yang sudah ada
 *     tidak ditimpa. Judul adalah kunci dedup, jadi tabrakan berarti dua orang
 *     menulis fakta berjudul sama pada cakupan berbeda — dan menimpa fakta
 *     bersama yang sudah dibaca seluruh tim secara otomatis adalah persis jenis
 *     hal yang tidak boleh terjadi tanpa manusia melihatnya. Tabrakan
 *     dikembalikan sebagai daftar supaya bisa dilaporkan.
 */
export function promoteMergedBranch(db, { repo, branch, into = null }) {
  const rows = db
    .prepare("SELECT id, title FROM entries WHERE repo=? AND scope='branch' AND branch=? ORDER BY title")
    .all(repo, branch);
  if (!rows.length) return { promoted: [], conflicts: [], into };

  const clash = db.prepare(
    "SELECT id FROM entries WHERE repo=? AND scope='shared' AND IFNULL(branch,'')='' AND title=?",
  );
  const move = db.prepare("UPDATE entries SET scope='shared', branch=NULL WHERE id=?");

  const promoted = [];
  const conflicts = [];

  // Transaksi ditulis eksplisit: driver-nya `node:sqlite` (DatabaseSync), yang
  // tidak punya pembungkus `db.transaction()` seperti better-sqlite3. Tanpa
  // transaksi, promosi yang gagal di tengah akan meninggalkan sebagian entri
  // sudah shared dan sebagian masih branch — keadaan yang tidak bisa dibedakan
  // dari hasil yang benar, dan karena itu tidak akan pernah diperbaiki.
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      if (clash.get(repo, r.title)) {
        conflicts.push(r.title);
        continue;
      }
      move.run(r.id);
      promoted.push(r.title);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { promoted, conflicts, into };
}
