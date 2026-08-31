# project-memory — plugin Claude Code internal Neuron

Memory proyek lintas-sesi **per branch**, disimpan di luar codebase. Tujuannya memangkas waktu yang habis untuk membaca ulang codebase dan menemukan ulang bisnis proses di setiap sesi baru.

## Yang dilakukan

- **RECALL** di awal tugas: agent membaca memory repo + branch, lalu memberi briefing padat (arsitektur, bispro, konvensi, jebakan, ADR yang mengikat) sebelum eksplorasi codebase dimulai.
- **CAPTURE** di akhir tugas: temuan baru disaring dan disimpan. Yang gampang di-grep dibuang; yang mahal ditemukan disimpan.
- **Sadar lineage branch**: mendeteksi branch induk, fork point, branch yang di-merge masuk, dan branch yang sudah memuat branch ini. Memory branch induk ikut terwarisi saat recall.
- **ADR**: keputusan arsitektur yang belum terdokumentasi dicatat dengan alternatif yang ditolak dan konsekuensinya, memakai relasi supersede alih-alih menghapus.

## Instalasi

```bash
/plugin marketplace add https://git.neuron.id/reusable/claude-plugin-project-memory.git
```

```bash
/plugin install project-memory@neuron
```

Setelah itu restart sesi Claude Code. Agent baru terbaca saat sesi dimulai.

## Di mana memory disimpan

```
~/.claude/project-memory/<repo-slug>/
  _shared.md                        # benar di semua branch
  _decisions.md                     # ADR yang belum terdokumentasi di repo
  branches/<branch>.md              # khusus satu branch
  branches/<branch>.lineage.json    # induk, fork point, merge masuk
```

**Memory bersifat lokal per orang dan tidak dibagikan.** Tiap anggota membangun store-nya sendiri. Tidak ada satu byte pun yang ditulis ke repo produk, dan tidak ada yang dikirim ke luar mesin. Temuan yang sudah matang dan layak dibagi sebaiknya dipromosikan lewat jalur dokumentasi repo (mis. `docs/`), bukan lewat file memory.

Agent diinstruksikan untuk tidak pernah menyimpan kredensial — hanya nama variabel atau lokasinya.

## Isi plugin

| Path | Fungsi |
|---|---|
| `plugin/agents/project-memory.md` | Definisi agent (mode RECALL & CAPTURE, aturan ADR) |
| `plugin/scripts/pm-context.sh` | Deteksi repo, branch, lineage — read-only, tidak pernah menulis ke repo |
| `plugin/hooks/session-context.sh` | Menyuntikkan protokol recall/capture di awal sesi |
| `plugin/hooks/hooks.json` | Pendaftaran hook `SessionStart` |

Hook dipakai karena plugin tidak bisa menulis ke `CLAUDE.md` pengguna. Hook diam total di direktori yang bukan repo git.

## Sebelum dipublikasikan

Sesuaikan URL di `plugin/.claude-plugin/plugin.json` dan di perintah instalasi di atas bila lokasi repo berbeda.

## Menguji perubahan secara lokal

```bash
/plugin marketplace add D:/Works/Neuron/claude-plugin-project-memory
```

Naikkan `version` di `plugin/.claude-plugin/plugin.json` **dan** di `.claude-plugin/marketplace.json` setiap kali merilis; keduanya harus cocok.
