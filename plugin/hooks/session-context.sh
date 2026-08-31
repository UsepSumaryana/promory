#!/usr/bin/env sh
# Recall otomatis di awal sesi.
#
# Hook ini MENGAMBIL SENDIRI briefing dari server lalu mencetaknya ke stdout;
# untuk SessionStart, stdout polos masuk ke konteks sesi apa adanya.
#
# Rancangan sebelumnya menyuruh model memanggil subagent `project-memory`.
# Itu tidak bisa diandalkan: sebagian harness Claude Code memasang aturan
# "jangan panggil Agent tool kecuali diminta pengguna" di level system prompt,
# yang selalu menang atas instruksi dari hook. Akibatnya recall tidak pernah
# jalan di sesi seperti itu, dan diam-diam — tidak ada pesan galat apa pun.
# Dengan hook yang mengambil datanya sendiri, recall tidak lagi bergantung pada
# keputusan model mana pun.
#
# Diam total kalau: bukan repo git, PM_MEMORY_* tidak diset, atau server tak
# terjangkau. Sesi harus tetap jalan tanpa memory, bukan menggantung.

command -v curl >/dev/null 2>&1 || exit 0
git rev-parse --show-toplevel >/dev/null 2>&1 || exit 0
[ -n "${PM_MEMORY_URL:-}" ] || exit 0
[ -n "${PM_MEMORY_TOKEN:-}" ] || exit 0

CTX="$(sh "$(dirname "$0")/../scripts/pm-context.sh" 2>/dev/null)" || exit 0
field() { echo "$CTX" | sed -n "s/^$1: //p" | head -1; }

REPO="$(field repo_slug)"
BRANCH="$(field branch)"
[ -n "$REPO" ] && [ -n "$BRANCH" ] || exit 0

# Induk + branch yang di-merge masuk: memory mereka ikut diwarisi saat recall.
PARENT="$(field parent_branch)"
[ "$PARENT" = "unknown" ] && PARENT=""
MERGED="$(echo "$CTX" | sed -n "/^merged_in:/,/^[a-z_]*:/p" \
  | sed -n "s/.*Merge branch '\([^']*\)'.*/\1/p" | sort -u | tr '\n' ',' | sed 's/,$//')"
INHERIT="$(echo "$PARENT,$MERGED" | sed 's/^,//; s/,$//')"

# URL bisa ditulis dengan atau tanpa akhiran /mcp; kupas supaya /brief benar.
BASE="$(echo "$PM_MEMORY_URL" | sed 's#/mcp/*$##; s#/*$##')"

esc() { echo "$1" | sed 's/ /%20/g'; }

# -f: curl gagal (exit != 0) pada status 4xx/5xx, bukan mengembalikan badan
# galatnya sebagai "hasil". Tanpa ini, halaman 404 dari reverse proxy ikut
# tersuntik ke konteks sesi sebagai kalau-kalau itu memory — pernah terjadi.
BRIEF="$(curl -sf --max-time 6 \
  -H "Authorization: Bearer $PM_MEMORY_TOKEN" \
  "$BASE/brief?repo=$(esc "$REPO")&branch=$(esc "$BRANCH")&inherit=$(esc "$INHERIT")" 2>/dev/null)" || exit 0
[ -n "$BRIEF" ] || exit 0

# Sabuk pengaman kedua: apa pun yang berbau HTML jelas bukan briefing kita.
case "$BRIEF" in *'<html'*|*'<!DOCTYPE'*|*'<HTML'*) exit 0 ;; esac

cat <<EOF
# Memory proyek (project-memory) — repo \`$REPO\`, branch \`$BRANCH\`

Berikut isi memory tim untuk repo ini, sudah diambil otomatis. Pakai sebagai
titik awal supaya tidak mengeksplorasi ulang hal yang sudah diketahui. Fakta di
bawah adalah snapshot saat ditulis — verifikasi ulang apa pun yang menyebut
path, fungsi, atau flag sebelum dipakai.

$BRIEF

---
Kalau di akhir tugas ada hal baru yang layak diingat tim — alur bispro,
keputusan desain beserta alternatif yang ditolak, jebakan yang menghabiskan
waktu, konvensi tim, cara menjalankan atau men-debug sesuatu, keputusan
non-teknikal dari user — simpan dengan skill \`/project-memory:simpan-memory\`.
Jangan menyimpan hal yang gampang di-grep dari kode, dan jangan pernah
menyimpan kredensial: isinya permanen dan terbaca seluruh tim.
EOF
