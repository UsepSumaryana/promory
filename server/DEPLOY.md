# Deploy server project-memory ke VPS

Butuh Node **>= 22.5** (penyimpanan memakai `node:sqlite` bawaan Node, tanpa modul native — tidak ada kompilasi saat install).

## 1. Siapkan pengguna dan direktori

```bash
sudo useradd --system --home /opt/project-memory --shell /usr/sbin/nologin project-memory
sudo mkdir -p /opt/project-memory /var/lib/project-memory
sudo chown -R project-memory:project-memory /opt/project-memory /var/lib/project-memory
```

## 2. Pasang kode

```bash
sudo -u project-memory git clone https://github.com/UsepSumaryana/promory.git /opt/project-memory
cd /opt/project-memory/server && sudo -u project-memory npm ci --omit=dev
```

## 3. Konfigurasi

```bash
sudo -u project-memory cp .env.example .env && sudo chmod 600 .env
```

`PM_TOKENS` hanya dipakai untuk **menyemai pengguna pertama**, dan hanya selagi tabel `users` masih kosong. Setelah itu database yang jadi sumber kebenaran, dan mengubah `PM_TOKENS` tidak lagi berpengaruh — ini yang mencegah env var lama diam-diam menghidupkan kembali akses yang sudah dicabut lewat GUI.

Cara yang disarankan: kosongkan `PM_TOKENS`, lalu buat admin pertama lewat CLI setelah service jalan:

```bash
sudo -u project-memory node src/admin.mjs add usep --admin
```

Token tampil **sekali saja** — server hanya menyimpan hash SHA-256-nya. Anggota berikutnya dibuat lewat GUI.

`PM_STALE_DAYS` (default 120) menentukan kapan entri mulai ditandai **PERIKSA ULANG** pada briefing. Penandanya sengaja hanya muncul pada entri yang benar-benar tua — peringatan yang menempel di semua entri akan diabaikan model, sama seperti pengingat yang muncul di setiap prompt berubah jadi wallpaper.

## 4. Jalankan sebagai service

```bash
sudo cp deploy/project-memory.service /etc/systemd/system/ && sudo systemctl enable --now project-memory
```

```bash
curl -s localhost:8787/health
```

## 5. GUI admin

Setelah service jalan, GUI ada di `/ui`. Masuk dengan token admin; token member akan ditolak dengan 403.

Dari GUI Anda bisa menjelajah memory per repo, menyunting dan menghapus entri yang salah, melihat ADR dan lineage, membaca audit, serta membuat, merotasi, menonaktifkan, dan mengubah peran anggota.

Dua hal yang perlu diketahui:

- **Token hanya tampil sekali** saat dibuat atau dirotasi. Yang hilang tidak bisa dibaca ulang, hanya dirotasi.
- **Admin aktif terakhir tidak bisa dinonaktifkan atau diturunkan** lewat GUI — permintaan itu ditolak 409. Kalau tetap terjadi kebuntuan, pulihkan lewat CLI di VPS:

```bash
sudo -u project-memory node src/admin.mjs list
```

## 6. TLS di depannya

```bash
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/project-memory && sudo certbot --nginx -d memory.example.com
```

Server sengaja hanya mendengarkan `127.0.0.1`. Token bearer ikut di setiap permintaan, jadi tanpa TLS token itu terbaca siapa pun di jalur jaringan. Jangan mengubah `PM_HOST` ke `0.0.0.0`.

## 7. Setiap anggota tim

```bash
/plugin marketplace add https://github.com/UsepSumaryana/promory.git
```

```bash
/plugin install project-memory@bakhija
```

Lalu set dua environment variable di mesin masing-masing, dan restart sesi Claude Code:

Di `~/.claude/settings.json` masing-masing:

```json
{ "env": { "PM_MEMORY_URL": "https://memory.example.com/mcp", "PM_MEMORY_TOKEN": "<token-pribadi>" } }
```

`PM_MEMORY_TOKEN` adalah rahasia pribadi. Jangan menaruhnya di file yang di-commit, dan jangan membagikannya ke rekan — minta token sendiri.

Untuk mengaktifkannya hanya di repo tertentu, taruh blok `env` yang sama di `.claude/settings.local.json` repo itu alih-alih di settings global, dan pastikan `.claude/` diabaikan git di sana. Lihat bagian "Aktif di workspace tertentu saja" di README.

## Backup

Seluruh isi memory ada di satu file SQLite:

```bash
sqlite3 /var/lib/project-memory/memory.db ".backup '/var/backups/memory-$(date +%F).db'"
```

Pakai `.backup`, bukan `cp` — mode WAL berarti salinan mentah bisa tertangkap di tengah transaksi. Jadwalkan lewat cron dan simpan salinannya di luar VPS.

## Operasional

Tab **Audit** di GUI menampilkan hal yang sama, tapi lewat shell:

```bash
sudo -u project-memory sqlite3 /var/lib/project-memory/memory.db "SELECT at, author, action, repo, detail FROM audit ORDER BY id DESC LIMIT 30;"
```

Mencabut akses seseorang: nonaktifkan lewat GUI (tab Akses) atau `node src/admin.mjs disable <id>`. Berlaku seketika pada permintaan berikutnya — tidak perlu restart. Entri yang sudah dia tulis tetap ada beserta namanya.

## Yang harus Anda tanggung sendiri dengan rute VPS

Backup, uptime, pembaruan keamanan OS, dan perpanjangan sertifikat menjadi tanggung jawab Anda. Kalau server mati, agent kehilangan recall — ia dirancang melapor dan lanjut tanpa memory, jadi sesi tidak menggantung, tapi keunggulan kecepatannya hilang sampai server kembali.
