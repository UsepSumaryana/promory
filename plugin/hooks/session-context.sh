#!/usr/bin/env sh
# Menyuntikkan protokol recall/capture ke konteks sesi.
# Ini pengganti catatan di CLAUDE.md global — plugin tidak bisa menulis ke sana,
# jadi instruksinya dikirim lewat SessionStart hook agar tiap anggota tim
# mendapat perilaku otomatis yang sama tanpa menyunting file apa pun.
# Diam saja kalau tidak di dalam repo git: tanpa branch, agent ini tidak berguna.

git rev-parse --show-toplevel >/dev/null 2>&1 || exit 0

cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Plugin project-memory aktif. Agent `project-memory` menyimpan memory proyek per branch di ~/.claude/project-memory/, di luar codebase.\n\n- RECALL: di awal tugas non-trivial pada repo git (butuh paham arsitektur, bispro, atau menyentuh lebih dari satu file), panggil Agent `project-memory` dengan `RECALL: <ringkasan tugas>` SEBELUM mulai mengeksplorasi codebase. Lewati untuk pertanyaan sepele atau edit satu baris.\n- CAPTURE: setelah menyelesaikan tugas seperti itu, kalau ada yang baru dipelajari (alur bispro, keputusan desain, jebakan yang menghabiskan waktu, konvensi tim, cara menjalankan atau men-debug sesuatu, keputusan non-teknikal dari user), panggil Agent `project-memory` dengan `CAPTURE:` diikuti daftar temuannya. Jangan kirim hal yang gampang di-grep dari kode.\n- Jangan pernah menaruh isi memory ini di dalam repo, dan jangan menyimpan kredensial."}}
JSON
