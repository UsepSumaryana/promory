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
sudo -u project-memory git clone <url-repo-plugin> /opt/project-memory
cd /opt/project-memory/server && sudo -u project-memory npm ci --omit=dev
```

## 3. Konfigurasi

```bash
sudo -u project-memory cp .env.example .env && sudo chmod 600 .env
```

Isi `PM_TOKENS` dengan satu token per orang. Token acak:

```bash
openssl rand -hex 32
```

Satu token per orang, bukan token bersama — nama di sisi kiri titik dua tercatat sebagai author tiap entri, dan itu satu-satunya cara menelusuri asal sebuah fakta.

## 4. Jalankan sebagai service

```bash
sudo cp deploy/project-memory.service /etc/systemd/system/ && sudo systemctl enable --now project-memory
```

```bash
curl -s localhost:8787/health
```

## 5. TLS di depannya

```bash
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/project-memory && sudo certbot --nginx -d memory.neuron.id
```

Server sengaja hanya mendengarkan `127.0.0.1`. Token bearer ikut di setiap permintaan, jadi tanpa TLS token itu terbaca siapa pun di jalur jaringan. Jangan mengubah `PM_HOST` ke `0.0.0.0`.

## 6. Setiap anggota tim

```bash
/plugin marketplace add <url-repo-plugin>
```

```bash
/plugin install project-memory@neuron
```

Lalu set dua environment variable di mesin masing-masing, dan restart sesi Claude Code:

```bash
export PM_MEMORY_URL=https://memory.neuron.id/mcp
export PM_MEMORY_TOKEN=<token-pribadi>
```

`PM_MEMORY_TOKEN` adalah rahasia pribadi. Jangan menaruhnya di file yang di-commit, dan jangan membagikannya ke rekan — minta token sendiri.

## Backup

Seluruh isi memory ada di satu file SQLite:

```bash
sqlite3 /var/lib/project-memory/memory.db ".backup '/var/backups/memory-$(date +%F).db'"
```

Pakai `.backup`, bukan `cp` — mode WAL berarti salinan mentah bisa tertangkap di tengah transaksi. Jadwalkan lewat cron dan simpan salinannya di luar VPS.

## Operasional

Melihat siapa menulis apa:

```bash
sudo -u project-memory sqlite3 /var/lib/project-memory/memory.db "SELECT at, author, action, repo, detail FROM audit ORDER BY id DESC LIMIT 30;"
```

Mencabut akses seseorang: hapus barisnya dari `PM_TOKENS`, lalu `sudo systemctl restart project-memory`. Entri yang sudah dia tulis tetap ada beserta namanya.

## Yang harus Anda tanggung sendiri dengan rute VPS

Backup, uptime, pembaruan keamanan OS, dan perpanjangan sertifikat menjadi tanggung jawab Anda. Kalau server mati, agent kehilangan recall — ia dirancang melapor dan lanjut tanpa memory, jadi sesi tidak menggantung, tapi keunggulan kecepatannya hilang sampai server kembali.
