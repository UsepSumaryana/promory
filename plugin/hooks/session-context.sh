#!/usr/bin/env sh
# session-context.sh - Recall otomatis di awal sesi.
#
# Hook ini MENGAMBIL SENDIRI briefing dari server lalu mencetaknya ke stdout;
# untuk SessionStart, stdout polos masuk ke konteks sesi apa adanya.
#
# Rancangan sebelumnya menyuruh model memanggil subagent `project-memory`.
# Itu tidak bisa diandalkan: sebagian harness Claude Code memasang aturan
# "jangan panggil Agent tool kecuali diminta pengguna" di level system prompt,
# yang selalu menang atas instruksi dari hook. Akibatnya recall tidak pernah
# jalan di sesi seperti itu, dan diam-diam - tanpa pesan galat apa pun.
# Dengan hook yang mengambil datanya sendiri, recall tidak lagi bergantung pada
# keputusan model mana pun.
#
# Kalau cwd BUKAN repo git, hook tidak lagi berhenti tanpa jejak. Workspace
# payung yang berisi banyak repo terpisah adalah pola kerja yang sah, dan versi
# sebelumnya membuat memory tampak mati di sana tanpa satu pun petunjuk kenapa.
# Sekarang sesi seperti itu diberi catatan singkat, dan memory sungguhannya
# dimuat oleh touch-memory.sh begitu ada file di dalam repo yang disentuh.
set -u

PM_SCRIPTS="$(dirname "$0")/../scripts"
. "$PM_SCRIPTS/pm-common.sh" 2>/dev/null || exit 0
pm_ready || exit 0

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"

if [ -z "$ROOT" ]; then
  # Tanpa repo tidak ada identitas, jadi tidak ada yang bisa ditanyakan ke
  # server. Catatan ini murni lokal - nol permintaan jaringan.
  SUB=""
  for d in ./*/; do
    [ -d "$d" ] || continue
    [ -e "$d/.git" ] || continue
    SUB="$SUB $(basename "$d")"
  done
  [ -n "$SUB" ] || exit 0
  cat <<EOF
# Memory proyek - belum aktif

Direktori kerja sesi ini bukan repo git, jadi belum ada identitas repo untuk
mengambil memory. Sub-repo yang terlihat di bawahnya:$SUB

Memory sebuah repo akan dimuat OTOMATIS begitu kamu membaca atau mengubah file
di dalamnya - termasuk repo di luar direktori sesi ini. Tidak ada tool yang
perlu kamu panggil untuk itu.
EOF
  exit 0
fi

pm_load_ctx "$ROOT" || exit 0

# Anggaran byte briefing. Default 4000: cukup untuk beberapa entri penuh tanpa
# memicu pemotongan harness. Naikkan lewat PM_BRIEF_BUDGET kalau memory sebuah
# repo sudah banyak dan terlalu banyak entri turun jadi judul saja - server
# memberi tahu berapa yang tersisa, jadi angkanya bisa disetel berdasarkan itu.
BUDGET="$(pm_budget "${PM_BRIEF_BUDGET:-}" 4000)"

# -f: curl gagal (exit != 0) pada status 4xx/5xx, bukan mengembalikan badan
# galatnya sebagai "hasil". Tanpa ini, halaman 404 dari reverse proxy ikut
# tersuntik ke konteks sesi seolah-olah itu memory - pernah terjadi.
BRIEF="$(curl -sf --max-time 6 \
  -H "Authorization: Bearer $PM_MEMORY_TOKEN" \
  "$PM_BASE/brief?repo=$(pm_esc "$PM_REPO")&branch=$(pm_esc "$PM_BRANCH")&inherit=$(pm_esc "$PM_INHERIT")&budget=$BUDGET&mode=orientation&root=$PM_ROOTC" 2>/dev/null)" || exit 0
[ -n "$BRIEF" ] || exit 0

# Sabuk pengaman kedua: apa pun yang berbau HTML jelas bukan briefing kita.
pm_is_html "$BRIEF" && exit 0

# Batas ukuran. Stdout hook yang besar dipotong harness jadi pratinjau beberapa
# KB pertama, sisanya dibuang ke file yang tidak dibaca model - recall tampak
# berhasil padahal separuh isinya hilang (pernah terjadi pada 18,9 KB). Server
# sudah mengirim indeks padat; ini jaring terakhir kalau memory tumbuh banyak.
# Batasnya mengikuti anggaran plus margin, bukan angka tetap. Versi bernilai
# tetap 6000 justru memotong briefing saat PM_BRIEF_BUDGET dinaikkan - jaring
# pengaman berubah jadi pengikat, dan knob-nya tidak berfungsi.
# `head -c` hanya dipanggil kalau briefingnya memang kepanjangan; panjang
# string sudah diketahui builtin, jadi jalur normalnya nol proses.
if [ "${#BRIEF}" -gt "$((BUDGET + 1500))" ]; then
  BRIEF="$(printf '%s' "$BRIEF" | head -c "$((BUDGET + 1500))")"
fi

cat <<EOF
# Memory proyek - \`$PM_REPO\` @ \`$PM_BRANCH\`

Isi di bawah **SUDAH ADA di konteksmu**, dimuat otomatis oleh plugin
project-memory. Kamu tidak perlu - dan jangan - memanggil tool apa pun untuk
mendapatkannya.

Kalau pengguna bertanya apakah kamu memakai project-memory, jawab YA dan sebut
apa yang kamu terima. JANGAN menjawab "belum" hanya karena kamu tidak memanggil
tool: memory di sistem ini disuntikkan lewat hook, bukan lewat pemanggilan tool,
jadi tidak adanya tool call bukan berarti memory tidak dipakai.

$BRIEF

Kalau sesi ini juga menyentuh repo LAIN, memory repo itu akan menyusul otomatis
begitu ada filenya yang kamu baca atau ubah.

Penulisan ke memory TIDAK otomatis - kamu yang harus memulainya. Begitu ada hal
yang mahal ditemukan dan tidak jelas dari membaca satu file (alur bispro,
keputusan desain beserta alternatif yang ditolak, jebakan yang menghabiskan
waktu, konvensi tim, cara menjalankan atau men-debug sesuatu, keputusan
non-teknikal dari pengguna), jalankan skill \`/project-memory:simpan-memory\`.
Tulis langsung tanpa menunggu konfirmasi pengguna, lalu laporkan singkat apa
yang disimpan. Temuan yang tidak disimpan hilang begitu sesi berakhir.
EOF
