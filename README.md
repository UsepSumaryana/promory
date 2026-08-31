# project-memory — plugin Claude Code internal Neuron

Memory proyek **bersama**, per branch, disimpan di server MCP tim — di luar codebase. Tujuannya memangkas waktu yang habis untuk membaca ulang codebase dan menemukan ulang bisnis proses di setiap sesi baru, dan membuat temuan satu orang langsung terpakai oleh yang lain.

## Yang dilakukan

- **RECALL** di awal tugas: agent membaca memory repo + branch dari server, lalu memberi briefing padat (arsitektur, bispro, konvensi, jebakan, ADR yang mengikat) sebelum eksplorasi codebase dimulai.
- **CAPTURE** di akhir tugas: temuan baru disaring dan dikirim ke server. Yang gampang di-grep dibuang; yang mahal ditemukan disimpan.
- **Sadar lineage branch**: mendeteksi branch induk, fork point, branch yang di-merge masuk, dan branch yang sudah memuat branch ini. Memory branch induk ikut terwarisi saat recall.
- **ADR**: keputusan arsitektur yang belum terdokumentasi dicatat dengan alternatif yang ditolak dan konsekuensinya. Penomoran otomatis, dan keputusan yang dibatalkan ditandai superseded — tidak pernah dihapus.
- **Atribusi dan audit**: tiap entri membawa nama penulisnya, dan setiap tulis/hapus tercatat di tabel audit.

## Dua bagian

| Bagian | Di mana | Fungsi |
|---|---|---|
| `server/` | VPS tim | MCP server + GUI admin + SQLite. Lihat [DEPLOY.md](server/DEPLOY.md) |
| `plugin/` | Mesin tiap anggota | Agent, script lineage, hook, dan konfigurasi MCP |

## Instalasi untuk anggota tim

```bash
/plugin marketplace add https://github.com/UsepSumaryana/promory.git
```

```bash
/plugin install project-memory@neuron
```

Lalu set dua environment variable dan restart sesi Claude Code:

```bash
export PM_MEMORY_URL=https://memory.example.com/mcp
export PM_MEMORY_TOKEN=<token-pribadi-dari-admin>
```

Token bersifat pribadi — jangan di-commit, jangan dibagikan. Nama yang dipetakan ke token itulah yang muncul sebagai penulis tiap entri.

## Isi plugin

| Path | Fungsi |
|---|---|
| `plugin/agents/project-memory.md` | Definisi agent (mode RECALL & CAPTURE, aturan ADR) |
| `plugin/scripts/pm-context.sh` | Deteksi repo, branch, lineage — read-only, tidak pernah menulis ke repo |
| `plugin/hooks/session-context.sh` | Menyuntikkan protokol recall/capture di awal sesi |
| `plugin/.mcp.json` | Sambungan ke server memory, URL dan token dari environment |

Hook dipakai karena plugin tidak bisa menulis ke `CLAUDE.md` pengguna. Hook diam total di direktori yang bukan repo git.

## Identitas repo lintas anggota

Slug repo diturunkan dari **URL remote**, bukan nama direktori, jadi dua orang yang meng-clone repo yang sama ke folder berbeda tetap menulis ke ruang memory yang sama. Normalisasi menutup semua cara URL yang sama bisa tertulis berbeda — skema `https`/`ssh`/`scp`, `user@`, nomor port, `/` atau `.git` di ujung, dan beda huruf besar-kecil — sementara path lengkap setelah host dipertahankan supaya dua repo bernama sama di subgrup berbeda tidak saling menimpa.

Satu kasus yang tidak bisa ditangani: repo **tanpa remote sama sekali**. Di situ satu-satunya nama yang tersisa adalah nama folder, dan itu memang berbeda antar orang. Script menandainya lewat `repo_slug_source: fallback-nama-direktori` dan agent diinstruksikan memperingatkan bahwa memory tersebut tidak akan menyatu dengan rekan.

## Retrieval dua tahap (untuk skala ribuan entri)

**Tahap 1 — orientasi, di awal sesi.** SessionStart hook berjalan sebelum pengguna mengetik apa pun, jadi relevansi belum bisa dihitung. Yang dikirim hanya peta: jumlah entri per tipe, ADR yang mengikat, lineage, dan entri ber-pin. **Ukurannya tetap ~1,4 KB baik pada 14 entri maupun 2.014 entri.**

**Tahap 2 — entri relevan, setiap prompt.** UserPromptSubmit hook meneruskan stdin-nya ke `POST /relevant`; server mengurai prompt, memeringkat entri dengan BM25 lewat indeks FTS5, dan menyuntikkan hanya yang cocok. Terukur 0,9–1,8 KB per prompt, 138–156 ms pada 2.014 entri.

Tiga penjagaan yang membuatnya tidak menjadi beban:

- **Ambang relevansi.** Query OR mencocokkan entri yang hanya kena satu kata umum. Tanpa ambang, pertanyaan soal `maxIdle` ikut menarik entri tentang alur order hanya karena kata "koneksi". Entri dipertahankan hanya bila skor BM25-nya masih dalam rasio 0,55 dari yang terbaik.
- **Tidak mengulang.** Server melacak entri yang sudah disuntikkan per sesi. Tanpa ini, hook yang berjalan di setiap pesan akan mengirim ulang hal yang sama dan biayanya melebihi mengirim semuanya sekali.
- **Diam saat tidak relevan.** Sapaan seperti "ok lanjut ya" menghasilkan nol byte.

**Pin.** Karena orientasi tidak memuat seluruh entri, `pinned` adalah cara menjamin sebuah fakta selalu ikut di awal sesi. Setel lewat tombol Pin di GUI.

Prompt pengguna dikirim ke server memory untuk pemeringkatan. Server tidak menyimpannya — hanya id entri yang sudah dikirim, di memori proses, hilang saat restart.

## GUI admin

Ada di `/ui` pada server yang sama, hanya untuk token ber-peran admin. Fungsinya: menjelajah dan mencari memory per repo, menyunting dan menghapus entri yang salah, melihat ADR dan lineage, membaca audit, serta mengelola anggota (buat token, rotasi, nonaktifkan, ubah peran).

Kurasi manusia inilah jawaban atas risiko terbesar memory bersama: agent bisa menulis fakta yang salah, dan tanpa tempat untuk memperbaikinya, kesalahan itu menyebar ke seluruh tim.

Beberapa keputusan yang mungkin mengejutkan:

- **Token disimpan sebagai hash SHA-256**, jadi hanya tampil sekali saat dibuat atau dirotasi. Database yang bocor tidak menyerahkan akses siapa pun.
- **Admin aktif terakhir tidak bisa dinonaktifkan atau diturunkan** — permintaan itu ditolak 409, karena pemulihannya hanya lewat shell VPS.
- **Suntingan lewat GUI mengubah kolom penulis** menjadi nama kurator, supaya kolom itu selalu berarti "siapa yang bertanggung jawab atas isi ini sekarang".
- **Halaman `/ui` disajikan tanpa autentikasi** karena isinya hanya kerangka kosong; semua datanya lewat `/api` yang menuntut peran admin. Menaruh token di URL demi "mengamankan" halaman justru membocorkannya ke log akses dan riwayat browser.
- Isi memory ditulis agent, jadi GUI memperlakukannya sebagai data tak tepercaya: semua render lewat `textContent`, tidak pernah `innerHTML`, dengan CSP yang menutup sumber skrip eksternal.

Pemulihan darurat lewat shell VPS:

```bash
node src/admin.mjs list | add <nama> --admin | rotate <id> | disable <id> | enable <id>
```

## Tool MCP

`memory_recall` · `memory_write` · `memory_search` · `memory_delete` · `adr_write` · `adr_list` · `lineage_put`

Uji server yang sedang jalan:

```bash
cd server && PM_TOKEN=<token> node test/smoke.mjs
```

## Yang perlu disadari karena memory ini bersama

Memory bersama adalah **publikasi ke tim**, bukan catatan pribadi. Fakta salah di dalamnya menyesatkan semua orang dan akan diperlakukan agent lain sebagai kebenaran. Karena itu:

- Agent diinstruksikan menandai `confidence: likely` untuk apa pun yang belum terkonfirmasi, dan menghapus memory lama yang terbukti salah alih-alih membiarkan dua fakta bertentangan.
- Server **menolak** tulisan yang menyerupai kredensial di titik tulis, bukan membersihkannya diam-diam. Sekali tersimpan, isinya permanen dan terbaca semua orang — jadi penolakan lebih baik daripada pembersihan.
- Judul entri adalah kunci dedup: judul sama pada repo, scope, dan branch yang sama memperbarui entri lama, bukan menumpuk duplikat.

## Kalau server mati

Agent melapor bahwa memory tidak tersedia lalu melanjutkan tanpanya. Sesi tidak menggantung, tapi keunggulan kecepatannya hilang sampai server kembali. Backup, uptime, dan sertifikat TLS jadi tanggung jawab tim yang mengelola VPS — lihat bagian akhir [DEPLOY.md](server/DEPLOY.md).

## Sebelum dipublikasikan

URL repo sudah menunjuk ke https://github.com/UsepSumaryana/promory. Yang masih placeholder hanya **domain server memory** — ganti `memory.example.com` di `server/deploy/nginx.conf.example` dan default `PM_MEMORY_URL` di `plugin/.mcp.json` dengan domain VPS Anda.

## Merilis perubahan

Naikkan `version` di `plugin/.claude-plugin/plugin.json` **dan** di `.claude-plugin/marketplace.json`; keduanya harus cocok.

Menguji secara lokal sebelum rilis:

```bash
/plugin marketplace add D:/Works/Neuron/claude-plugin-project-memory
```
