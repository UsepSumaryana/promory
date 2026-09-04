#!/usr/bin/env sh
# pm-common.sh — logika bersama untuk ketiga hook.
#
# Sebelum ini, session-context.sh dan prompt-memory.sh menyalin blok yang sama
# (resolusi identitas repo, penyusunan lineage, normalisasi URL, sabuk pengaman
# HTML). Hook ketiga akan menjadikannya tiga salinan, dan salinan yang menyimpang
# adalah bug yang tidak kelihatan. Semuanya dipusatkan di sini.
#
# File ini di-source, bukan dieksekusi. Pemanggil harus menyetel PM_SCRIPTS ke
# direktori tempat pm-context.sh berada.

# --- resolusi repo dari sebuah path -----------------------------------------
# Menerima path file ATAU direktori, absolut atau relatif, dengan pemisah `/`
# maupun `\`. Mengembalikan akar worktree git, atau kosong kalau path itu tidak
# berada di dalam repo mana pun.
#
# Ini inti dari perbaikan: repo ditentukan oleh LOKASI FILE yang disentuh, bukan
# oleh direktori tempat sesi dimulai. Sesi yang dibuka di folder payung — atau di
# repo yang sama sekali lain — tetap mengaktifkan memory repo yang benar begitu
# ada file di dalamnya yang dibaca atau diubah.
pm_repo_root() {
  _p="$(printf '%s' "$1" | sed 's|\\\\*|/|g')"
  [ -n "$_p" ] || return 1
  # Path yang belum ada (Write ke file baru) tidak boleh membatalkan resolusi:
  # direktori induknya sudah cukup untuk menemukan repo.
  while [ -n "$_p" ] && [ ! -d "$_p" ]; do
    _parent="$(dirname "$_p")"
    [ "$_parent" = "$_p" ] && return 1
    _p="$_parent"
  done
  [ -d "$_p" ] || return 1
  git -C "$_p" rev-parse --show-toplevel 2>/dev/null
}

# --- identitas + lineage sebuah repo ----------------------------------------
# Menyetel PM_REPO, PM_BRANCH, PM_ROOTC, PM_INHERIT untuk repo di $1.
pm_load_ctx() {
  PM_CTX="$( cd "$1" 2>/dev/null && sh "$PM_SCRIPTS/pm-context.sh" 2>/dev/null )" || return 1
  [ -n "$PM_CTX" ] || return 1

  PM_REPO="$(printf '%s\n' "$PM_CTX" | sed -n 's/^repo_slug: //p' | head -1)"
  PM_BRANCH="$(printf '%s\n' "$PM_CTX" | sed -n 's/^branch: //p' | head -1)"
  [ -n "$PM_REPO" ] && [ -n "$PM_BRANCH" ] || return 1

  # Identitas stabil lintas clone; server memakainya untuk menyatukan slug yang
  # berbeda pada repo git yang sama.
  PM_ROOTC="$(printf '%s\n' "$PM_CTX" | sed -n 's/^repo_root_commit: //p' | head -1)"
  case "$PM_ROOTC" in *[!0-9a-f]*|"") PM_ROOTC="" ;; esac

  # Induk + branch yang di-merge masuk: memory mereka ikut diwarisi saat recall.
  _parent="$(printf '%s\n' "$PM_CTX" | sed -n 's/^parent_branch: //p' | head -1)"
  [ "$_parent" = "unknown" ] && _parent=""
  _merged="$(printf '%s\n' "$PM_CTX" | sed -n "/^merged_in:/,/^[a-z_]*:/p" \
    | sed -n "s/.*Merge branch '\([^']*\)'.*/\1/p" | sort -u | tr '\n' ',' | sed 's/,$//')"
  PM_INHERIT="$(printf '%s' "$_parent,$_merged" | sed 's/^,//; s/,$//')"
  return 0
}

# --- prasyarat ---------------------------------------------------------------
# Semua hook harus diam total kalau ini tidak terpenuhi: sesi wajib tetap jalan
# tanpa memory, bukan menggantung atau menyemburkan galat.
pm_ready() {
  command -v curl >/dev/null 2>&1 || return 1
  [ -n "${PM_MEMORY_URL:-}" ] || return 1
  [ -n "${PM_MEMORY_TOKEN:-}" ] || return 1
  # URL bisa ditulis dengan atau tanpa akhiran /mcp; kupas supaya rute benar.
  PM_BASE="$(printf '%s' "$PM_MEMORY_URL" | sed 's#/mcp/*$##; s#/*$##')"
  [ -n "$PM_BASE" ]
}

pm_esc() { printf '%s' "$1" | sed 's/ /%20/g'; }

# Anggaran non-numerik dari env akan merusak aritmetika; jatuhkan ke default.
pm_budget() {
  _b="$1"; _d="$2"
  case "$_b" in ''|*[!0-9]*) printf '%s' "$_d" ;; *) printf '%s' "$_b" ;; esac
}

# Apa pun yang berbau HTML jelas bukan memory kita, melainkan halaman galat dari
# reverse proxy. Pernah tersuntik ke konteks sesi sebagai kalau-kalau itu memory.
pm_is_html() {
  case "$1" in *'<html'*|*'<!DOCTYPE'*|*'<HTML'*) return 0 ;; *) return 1 ;; esac
}

# --- state per sesi ----------------------------------------------------------
# Dua daftar terpisah, dan pemisahan itu bukan hiasan:
#
#   seen   - repo yang sudah pernah ditanyakan ke server di sesi ini. Dipakai
#            untuk dedupe, supaya ratusan pembacaan file tidak jadi ratusan
#            permintaan. Repo yang TERNYATA belum punya memory pun masuk sini.
#   active - repo yang benar-benar punya memory. Dipakai prompt-memory.sh untuk
#            tahu repo mana yang sedang dikerjakan meskipun cwd sesi bukan repo
#            sama sekali. Kalau daftar ini disatukan dengan `seen`, setiap prompt
#            akan menanyakan repo-repo yang sudah diketahui kosong.
pm_state_file() {
  _sid="${1:-nosession}"
  _kind="${2:-seen}"
  _sid="$(printf '%s' "$_sid" | sed 's#[^A-Za-z0-9._-]#-#g')"
  _dir="${TMPDIR:-/tmp}/project-memory"
  mkdir -p "$_dir" 2>/dev/null
  printf '%s/%s-%s' "$_dir" "$_kind" "$_sid"
}

pm_state_has() { [ -f "$2" ] && grep -Fqx "$1" "$2" 2>/dev/null; }
pm_state_add() { pm_state_has "$1" "$2" || printf '%s
' "$1" >> "$2" 2>/dev/null || true; }

# --- escaping JSON ----------------------------------------------------------
# PostToolUse hanya bisa menyuntikkan konteks lewat JSON, jadi teks briefing
# harus di-escape. Dilakukan dengan sed, bukan node/python/jq, dengan alasan
# yang sama seperti di tempat lain: plugin ini harus jalan di mesin rekan tanpa
# menuntut apa pun terpasang. Alternatifnya - menambah rute pembungkus JSON di
# server - berarti memory mati sampai server sempat di-redeploy.
#
# Urutan penting: backslash lebih dulu, sebelum escape lain memasukkan backslash
# baru yang lalu ikut ter-escape dua kali.
pm_json_escape() {
  sed -e 's#\\#\\\\#g'       -e 's#"#\\"#g'       -e 's#\r##g'       -e 's#\t#\\t#g'     | sed -e ':a' -e 'N' -e '$!ba' -e 's#\n#\\n#g'
}

# --- pengurai JSON minimal ---------------------------------------------------
# Mengambil satu field string dari payload stdin hook. Dipakai sed, bukan jq:
# jq tidak selalu terpasang, dan menjalankan node atau python di sini akan
# menambah puluhan milidetik pada SETIAP tool call. Kalau pola tidak cocok,
# hasilnya kosong dan pemanggil diam - jauh lebih baik daripada gagal ribut.
#
# Nilainya masih ter-escape gaya JSON (path Windows datang sebagai `D:\\Works`).
# Itu tidak perlu di-unescape karena pm_repo_root sudah meringkas rentetan
# backslash menjadi satu pemisah.
pm_json_field() {
  printf '%s' "$1" | sed -n 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1
}
