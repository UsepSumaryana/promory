# project-memory

Memory proyek **bersama**, per branch, disimpan di server MCP tim — di luar codebase. Tujuannya memangkas waktu yang habis untuk membaca ulang codebase dan menemukan ulang bisnis proses di setiap sesi baru, dan membuat temuan satu orang langsung terpakai oleh yang lain.

## Yang dilakukan

- **Baca otomatis, tanpa dipanggil.** Hook mengambil sendiri memory yang relevan dan menyuntikkannya ke konteks — tidak bergantung pada keputusan model, jadi tetap jalan di harness yang melarang pemanggilan Agent tool.
- **Mengikuti file, bukan direktori sesi.** Memory sebuah repo aktif begitu ada filenya yang dibaca atau diubah — meski sesi dimulai di workspace payung yang berisi banyak repo, atau di repo yang sama sekali lain. Satu sesi boleh menyentuh beberapa repo; masing-masing dapat memory-nya sendiri, berlabel.
- **Tulis atas inisiatif agent.** Skill `simpan-memory` menyaring temuan dan menyimpannya langsung tanpa meminta persetujuan, lalu melaporkan. Yang gampang di-grep dibuang; yang mahal ditemukan disimpan.
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
/plugin install project-memory@bakhija
```

Lalu sediakan dua environment variable dan restart Claude Code. Cara paling sederhana, berlaku di semua repo — di `~/.claude/settings.json`:

```json
{ "env": { "PM_MEMORY_URL": "https://memory.example.com/mcp", "PM_MEMORY_TOKEN": "<token-pribadi>" } }
```

Token bersifat pribadi — jangan di-commit, jangan dibagikan. Nama yang dipetakan ke token itulah yang muncul sebagai penulis tiap entri.

### Aktif di workspace tertentu saja

Plugin ini sengaja tidak berguna tanpa dua hal: `enabledPlugins` yang menyalakannya, dan `PM_MEMORY_*` yang memberinya kredensial. Kalau salah satu tidak ada, seluruh hook diam total — tidak ada briefing, tidak ada retrieval, tidak ada galat.

Sifat itu dipakai untuk membatasi cakupannya. Nonaktifkan global sekali:

```bash
claude plugin disable project-memory@bakhija --scope user
```

Lalu di dalam tiap repo yang diinginkan:

```bash
claude plugin enable project-memory@bakhija --scope local
```

dan pindahkan env-nya dari settings global ke `.claude/settings.local.json` repo itu:

```json
{ "env": { "PM_MEMORY_URL": "https://memory.example.com/mcp", "PM_MEMORY_TOKEN": "<token-pribadi>" } }
```

**Pastikan `.claude/` diabaikan git di repo tersebut** — file itu memuat token.

Dua lapis ini disengaja. `enabledPlugins` menentukan plugin dimuat atau tidak; `env` menentukan ke **server mana** workspace itu menulis. Begitu ada lebih dari satu server memory — misalnya satu internal dan satu untuk proyek klien — lapis kedua itulah yang mencegah memory nyasar ke tempat yang salah.

Alternatif yang tidak bergantung pada presedensi `enabledPlugins` antar-scope: cabut dari scope user lalu `claude plugin install project-memory@bakhija --scope local` di tiap repo. Lebih pasti, tapi tiap repo perlu dipasang dan di-update sendiri.

## Isi plugin

| Path | Fungsi |
|---|---|
| `plugin/hooks/session-context.sh` | SessionStart: mengambil orientasi dari server dan mencetaknya ke konteks |
| `plugin/hooks/prompt-memory.sh` | UserPromptSubmit: meneruskan prompt ke server, menyuntikkan entri relevan |
| `plugin/hooks/touch-memory.sh` | PostToolUse: mengaktifkan memory repo tempat file yang baru disentuh berada |
| `plugin/scripts/pm-common.sh` | Logika bersama ketiga hook — resolusi repo dari path, lineage, state per sesi |
| `plugin/skills/simpan-memory/SKILL.md` | Skill penulisan — penyaringan, dedup, ADR, lineage |
| `plugin/scripts/pm-context.sh` | Deteksi repo, branch, lineage — read-only, tidak pernah menulis ke repo |
| `plugin/agents/project-memory.md` | Agent opsional, untuk pekerjaan memory berat yang diminta pengguna sendiri |
| `plugin/.mcp.json` | Sambungan ke server memory, URL dan token dari environment |

Hook melakukan pengambilan memory **sendiri**, bukan menyuruh model memanggil tool. Itu keputusan penting: sebagian harness Claude Code memasang aturan "jangan panggil Agent tool kecuali diminta pengguna" di level system prompt, yang selalu menang atas instruksi dari hook — rancangan lama karena itu tidak pernah jalan di sesi seperti itu, dan gagalnya senyap.

Semua hook diam total saat `PM_MEMORY_*` tidak diset dan saat server tidak terjangkau.

Direktori yang bukan repo git **tidak** lagi mematikan plugin. Itu dulu penyebab kegagalan yang paling membingungkan: ketiga hook dibuka dengan `git rev-parse --show-toplevel || exit 0`, jadi sesi yang dimulai di workspace payung — satu folder berisi belasan repo terpisah — tidak pernah mendapat memory sama sekali, tanpa satu pun pesan galat, padahal seluruh pekerjaannya berlangsung di dalam sub-repo yang memory-nya penuh. Sekarang cwd hanya salah satu petunjuk; yang menentukan adalah lokasi file yang disentuh.

## Identitas repo lintas anggota

Identitas kanonis sebuah repo adalah **commit root**-nya (`git rev-list --max-parents=0 HEAD`) — identik di setiap clone, tidak bergantung nama remote, nama folder, maupun ada-tidaknya remote. Server memetakan commit root ke satu slug kanonis, jadi dua anggota yang slug-nya berbeda tetap menulis ke ruang memory yang sama.

Slug sendiri diturunkan dari URL remote dan dinormalisasi (skema, `user@`, port, `/` atau `.git` di ujung, huruf besar-kecil), dengan path lengkap setelah host dipertahankan supaya dua repo bernama sama di subgrup berbeda tidak menimpa satu sama lain. Slug tetap dipakai sebagai nama yang terbaca manusia.

**Kenapa commit root, bukan slug saja.** Rancangan awal hanya memakai slug, dan itu gagal di lapangan: dua anggota tim mendapat slug berbeda untuk repo git yang sama — satu `reusable-business-service-mini-ticast` (remote lengkap terbaca), satu `business-service-mini-ticast` (jatuh ke nama folder). Memory keduanya terbelah tanpa ada yang menyadari, dan itu kegagalan paling merugikan dari sistem ini: tujuan utamanya justru menyatukan temuan.

Batasnya: clone **shallow** (`--depth`) tidak punya commit root yang sebenarnya. Script menandainya dan server mengabaikan nilainya, jatuh kembali ke slug apa adanya.

Repo yang sudah terbelah sebelum penyatuan ini ada dibereskan di VPS:

```bash
node src/admin.mjs merge-repo <slug-asal> <slug-tujuan> <commit-root>
```

Entri berpindah, ADR dinomori ulang di tujuan, dan judul yang bentrok **dilewati serta dilaporkan** — menggabungkan dua tulisan berbeda dengan judul sama adalah keputusan manusia.

## Retrieval tiga tahap (untuk skala ribuan entri)

**Tahap 1 — orientasi, di awal sesi.** SessionStart hook berjalan sebelum pengguna mengetik apa pun, jadi relevansi belum bisa dihitung. Yang dikirim hanya peta: jumlah entri per tipe, ADR yang mengikat, lineage, dan entri ber-pin. **Ukurannya tetap ~1,4 KB baik pada 14 entri maupun 2.014 entri.**

**Tahap 2 — entri relevan, setiap prompt.** UserPromptSubmit hook meneruskan stdin-nya ke `POST /relevant`; server mengurai prompt, memeringkat entri dengan BM25 lewat indeks FTS5, dan menyuntikkan hanya yang cocok. Terukur 0,9–1,8 KB per prompt, 138–156 ms pada 2.014 entri.

**Tahap 3 — aktivasi per repo, begitu filenya disentuh.** PostToolUse hook membaca path file dari payload tool (`Read`, `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, dan — lewat pemindaian token perintah — `Bash`), mencari akar worktree git di atas path itu, lalu mengambil orientasi repo tersebut. Repo yang sama hanya ditanyakan **sekali per sesi**; repo yang ternyata belum punya memory ikut dicatat, supaya tidak ditanya ulang pada setiap file. Setelah aktif, repo itu juga ikut ditanyakan pada tahap 2 di prompt-prompt berikutnya, berlabel nama repo agar konvensi repo A tidak diterapkan ke repo B.

Pemicunya menyertakan `Read` dan bukan hanya penyuntingan, karena hanya `PostToolUse` yang punya `additionalContext` — pada `PreToolUse`, stdout hook cuma masuk debug log dan model tidak pernah melihatnya. Membaca file hampir selalu mendahului mengubahnya, jadi memory sudah masuk sebelum perubahan pertama ditulis.

Tiga penjagaan yang membuatnya tidak menjadi beban:

- **Ambang relevansi.** Query OR mencocokkan entri yang hanya kena satu kata umum. Tanpa ambang, pertanyaan soal `maxIdle` ikut menarik entri tentang alur order hanya karena kata "koneksi". Entri dipertahankan hanya bila skor BM25-nya masih dalam rasio 0,55 dari yang terbaik.
- **Tidak mengulang.** Server melacak entri yang sudah disuntikkan per sesi. Tanpa ini, hook yang berjalan di setiap pesan akan mengirim ulang hal yang sama dan biayanya melebihi mengirim semuanya sekali.
- **Diam saat tidak relevan.** Sapaan seperti "ok lanjut ya" menghasilkan nol byte.

**Pin.** Karena orientasi tidak memuat seluruh entri, `pinned` adalah cara menjamin sebuah fakta selalu ikut di awal sesi. Setel lewat tombol Pin di GUI.

Prompt pengguna dikirim ke server memory untuk pemeringkatan. Server tidak menyimpannya — hanya id entri yang sudah dikirim, di memori proses, hilang saat restart.

## Penulisan ke memory: sukarela, tapi diingatkan berkala

Penulisan **tidak dipaksa**. Tidak ada hook `Stop` yang memblokir penyelesaian sesi — keputusan sadar, supaya sesi tanya-jawab singkat tidak pernah terganggu dan tidak ada tekanan menghasilkan entri asal-jadi.

Konsekuensinya dorongan harus cukup kuat untuk tidak terlewat:

- **SessionStart** menutup briefing dengan pernyataan tegas bahwa penulisan tidak otomatis dan temuan yang tidak disimpan akan hilang.
- **UserPromptSubmit** menyisipkan pengingat mulai prompt ke-3, lalu setiap 3 prompt. Bukan di setiap pesan: pengingat yang selalu ada berubah jadi wallpaper yang diabaikan model, sekaligus biaya token yang terbuang. Pengingat tetap muncul walau tidak ada entri relevan — justru sesi seperti itu yang paling mungkin menghasilkan temuan baru.
- Skill `simpan-memory` **menulis langsung tanpa meminta persetujuan**, lalu melaporkan apa yang disimpan. Bertanya lebih dulu membuat temuan hilang di sesi tanpa pengawasan, dan kesalahan lebih murah diperbaiki lewat GUI kurasi daripada tidak pernah tercatat.

Kalau nanti terbukti masih terlalu sering terlewat, langkah berikutnya adalah hook `Stop` yang menolak penyelesaian sekali per sesi pada sesi substantif — lebih andal, tapi perlu penjaga anti-loop dan ambang supaya sesi remeh tidak diganggu.

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

URL repo sudah menunjuk ke https://github.com/UsepSumaryana/promory. Yang masih placeholder hanya **domain server memory** — ganti `memory.example.com` di `server/deploy/nginx.conf.example`, di contoh env pada README ini, dan default `PM_MEMORY_URL` di `plugin/.mcp.json` dengan domain VPS Anda.

## Merilis perubahan

Naikkan `version` di `plugin/.claude-plugin/plugin.json` **dan** di `.claude-plugin/marketplace.json`; keduanya harus cocok.

Ini bukan formalitas. Plugin dipasang sebagai salinan di `~/.claude/plugins/cache/<marketplace>/<plugin>/<versi>/`, dan updater membandingkan nomor versi — bukan isi file. Mengubah hook tanpa menaikkan versi membuat `claude plugin update` melaporkan "sudah terbaru" sementara salinan di cache tetap versi lama, dan perbaikannya tidak pernah aktif.

Mengubah nama marketplace juga mengubah id plugin (`project-memory@<marketplace>`). `plugin update` tidak bisa memindahkannya — pemasangan lama harus dicabut lalu dipasang ulang.

Menguji secara lokal sebelum rilis:

```bash
/plugin marketplace add D:/Works/Neuron/claude-plugin-project-memory
```
