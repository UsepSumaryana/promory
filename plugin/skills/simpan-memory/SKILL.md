---
description: Simpan temuan baru tentang proyek ini ke memory tim (project-memory). Pakai di akhir tugas non-trivial ketika ada yang baru dipelajari — alur bisnis proses, keputusan desain, jebakan yang menghabiskan waktu, konvensi tim, cara menjalankan atau men-debug sesuatu, atau keputusan non-teknikal dari user. Juga untuk memperbaiki dan menghapus memory lama yang ternyata salah.
---

**Tulis langsung, jangan meminta persetujuan.** Keputusan tim: agent menyaring dan menyimpan sendiri, lalu melaporkan apa yang disimpan. Bertanya "boleh saya simpan?" membuat temuan hilang di sesi tanpa pengawasan, dan kesalahan lebih murah diperbaiki lewat GUI kurasi daripada tidak pernah tercatat.

Kamu menyimpan temuan ke memory tim lewat tool MCP `memory_*` **secara langsung**. Jangan mendelegasikan ke subagent — sebagian harness melarang pemanggilan Agent tool tanpa permintaan eksplisit pengguna, dan skill ini memang ada supaya penyimpanan tidak bergantung pada itu.

## Langkah 1 — identitas repo dan branch

```
sh "${CLAUDE_PLUGIN_ROOT}/scripts/pm-context.sh"
```

Ambil `repo_slug`, `repo_root_commit`, dan `branch` dari outputnya. Pakai `repo_slug` dan `branch` apa adanya sebagai argumen `repo` dan `branch`, dan **selalu sertakan `root_commit`** bila `repo_root_commit` berisi sha — itu identitas repo yang stabil di semua clone, dan server memakainya untuk menyatukan slug yang berbeda pada repo git yang sama. Tanpa itu, tulisanmu bisa mendarat di ruang nama terpisah dari rekan yang slug-nya berbeda. Jangan mengarang atau menyesuaikan nilainya: slug diturunkan dari URL remote dan sudah dinormalisasi supaya semua anggota tim mendapat nilai yang sama berapa pun nama folder mereka. Mengubahnya membuat tulisanmu mendarat di ruang nama berbeda dan tidak pernah ditemukan rekan.

Kalau `repo_slug_source` bernilai `fallback-nama-direktori`, repo ini tidak punya remote. Tetap simpan, tapi beri tahu pengguna bahwa memory-nya tidak akan menyatu dengan rekan yang memakai nama folder berbeda.

## Langkah 2 — saring

Untuk tiap temuan, tanyakan tiga hal. **Simpan** hanya bila ketiganya terpenuhi: mahal ditemukan (butuh eksplorasi atau percobaan), akan relevan lagi nanti, dan tidak jelas dari membaca satu file.

**Buang** kalau bisa di-grep dalam hitungan detik (isi file, signature, daftar dependency, jumlah file), hanya berlaku untuk percakapan saat ini, sudah tertulis di CLAUDE.md / README / docs repo, atau masih dugaan yang belum terkonfirmasi.

Jangan pernah menyimpan kredensial. Sebut nama variabel atau lokasinya saja. Server akan menolak tulisan yang menyerupai kredensial, tapi jangan bergantung pada itu — yang lolos filter tersimpan permanen dan terbaca semua orang.

## Langkah 3 — cek duplikat sebelum menulis

Jalankan `memory_search` untuk judul yang mirip. `title` adalah kunci dedup: judul yang sama persis pada repo, scope, dan branch yang sama akan **memperbarui** entri lama alih-alih menumpuk duplikat. Kalau memang memperbarui fakta yang sama, pakai judul yang identik.

## Langkah 4 — tulis

`memory_write` dengan `scope: "shared"` bila benar untuk semua branch, atau `scope: "branch"` + `branch` bila hanya menyangkut pekerjaan branch ini (tujuan branch, WIP, sisa pekerjaan).

Isi `body` 1–4 kalimat dengan path file konkret, dan `why` dengan apa yang jadi lebih cepat atau lebih aman karenanya. Pakai `confidence: "likely"` untuk apa pun yang belum kamu konfirmasi sendiri — ini tulisan untuk orang lain, dan fakta salah di sini menyesatkan seluruh tim.

Kalau menemukan memory lama yang ternyata salah, hapus dengan `memory_delete` beserta alasannya. Jangan biarkan dua fakta bertentangan hidup berdampingan.

## Langkah 5 — ADR, bila layak

Sebuah temuan naik jadi ADR (`adr_write`) hanya bila ketiganya terpenuhi: ada pilihan nyata di antara beberapa opsi, mengikat atau membatasi pekerjaan berikutnya, dan mahal untuk dibalik. Preferensi gaya, hasil debugging, dan penemuan cara kerja kode bukan ADR. Kalau ragu, jangan.

Nomor diberikan otomatis server — jangan menomori sendiri. Isi `alternatives` dengan opsi yang ditolak beserta alasannya; bagian itulah yang paling mahal ditemukan ulang. Keputusan yang membatalkan keputusan lama ditulis sebagai ADR baru dengan `supersedes: <nomor lama>`; server menandai yang lama sebagai superseded tanpa menghapusnya.

Periksa dulu apakah repo sudah punya ADR sendiri (`docs/adr/`, `docs/decisions/`, wiki). Kalau ada, jangan salin isinya — cukup satu `memory_write` bertipe `reference` yang menunjuk ke lokasinya, dan pakai `adr_write` hanya untuk keputusan yang tidak pernah didokumentasikan di repo.

## Langkah 6 — lineage, bila berubah

Kalau `pm-context.sh` menunjukkan induk atau merge yang belum tercatat, perbarui dengan `lineage_put`. `parent_branch` dari script hanyalah tebakan heuristik: koreksi dengan bukti dari `merged_in` dan `contained_by`. Kalau kamu mengoreksi induk, **koreksi juga `fork_point`** agar konsisten — `git merge-base HEAD <induk-yang-benar>`. Isi `note` dengan alasan koreksinya supaya tidak ditebak ulang.

## Terakhir

Laporkan ke pengguna dalam beberapa baris: apa yang disimpan dan ke mana, apa yang dibuang beserta alasannya. Kalau server tidak bisa dihubungi, katakan itu terus terang dan jangan mencoba berulang kali — jangan pula menulis file lokal sebagai pengganti.
