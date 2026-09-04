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

# --- umur file ---------------------------------------------------------------
# stat(1) berbeda antara GNU (Linux, git-bash) dan BSD (macOS); dua-duanya
# dicoba, dan kalau tidak ada yang jalan cache dianggap basi (0 = 1970).
pm_mtime() {
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0
}

# --- identitas + lineage sebuah repo ----------------------------------------
# Menyetel PM_REPO, PM_BRANCH, PM_ROOTC, PM_INHERIT untuk repo di $1.
#
# Hasilnya DI-CACHE, dan itu bukan optimasi kosmetik. pm-context.sh butuh ~4,4
# detik pada repo dengan 17 ref, dan hampir seluruhnya bukan kerja git melainkan
# biaya proses: dua loop lineage memanggil `git` 34-51 kali, dan di Windows satu
# pemanggilan git saja ~90 ms.
#
#   loop parent_branch (17 x merge-base + rev-list) : 2533 ms
#   loop contained_by  (17 x is-ancestor)           : 1148 ms
#   tujuh perintah git tunggal lainnya              :  ~700 ms
#
# Tanpa cache, UserPromptSubmit membayar itu di SETIAP prompt - dan sejak memory
# bisa aktif untuk beberapa repo sekaligus, sampai tiga kali lipat.
#
# Yang di-cache adalah keempat nilai yang SUDAH diparse, bukan teks mentah
# pm-context.sh. Bedanya besar: menyimpan teks mentah tetap menyisakan sembilan
# pipeline sed/sort/tr pada setiap cache hit, dan pada Windows itu sendiri sudah
# ~800 ms. Cache berbentuk file yang bisa di-source membuat cache hit hanya
# berharga satu pemanggilan git untuk kunci invalidasinya.
#
# Kunci cache: sha HEAD + nama branch, keduanya dari satu pemanggilan git. TTL
# menutup sisa celahnya - `git fetch` bisa memunculkan ref baru yang mengubah
# induk tanpa menggeser HEAD, dan mendeteksi itu butuh pembacaan ref yang
# harganya justru sebanding dengan yang mau dihemat. Setel PM_CTX_TTL=0 untuk
# mematikan cache sepenuhnya.
pm_load_ctx() {
  _root="$1"
  _dir="${TMPDIR:-/tmp}/project-memory"
  # `mkdir -p` pada direktori yang sudah ada tetap satu proses (~73 ms di
  # Windows). Uji `-d` adalah builtin, jadi cache hit tidak membayarnya.
  [ -d "$_dir" ] || mkdir -p "$_dir" 2>/dev/null

  _ttl="${PM_CTX_TTL:-900}"
  case "$_ttl" in ''|*[!0-9]*) _ttl=900 ;; esac

  # Kunci invalidasi: sha HEAD + nama branch, dari SATU pemanggilan git. Nama
  # branch harus ikut - `git checkout -b` membuat branch baru tanpa menggeser
  # HEAD, dan kunci yang hanya berisi sha akan menyajikan branch yang lama.
  #
  # Kunci disimpan DI DALAM file cache, bukan di namanya. Menyusunnya jadi nama
  # file yang aman menuntut pipeline `sed` (~106 ms), sementara membandingkan dua
  # string setelah file di-source tidak berbiaya proses sama sekali. Nama file
  # cukup memakai basename worktree dan panjang path-nya - keduanya builtin, dan
  # kombinasi itu sudah memisahkan dua clone bernama sama.
  _cache=""
  if [ "$_ttl" -gt 0 ]; then
    _head="$(git -C "$_root" rev-parse HEAD --abbrev-ref HEAD 2>/dev/null)"
    [ -n "$_head" ] && _cache="$_dir/ctx-${_root##*/}-${#_root}"
  fi

  if [ -n "$_cache" ] && [ -f "$_cache" ]; then
    # TTL diuji dengan satu `find`, bukan `date` + `stat` (dua proses, ~140 ms).
    # Pembulatan ke atas supaya TTL di bawah satu menit tidak berubah menjadi
    # `-mmin -0`, yang tidak pernah cocok dan mematikan cache tanpa disadari.
    _mins=$(( (_ttl + 59) / 60 ))
    if [ -n "$(find "$_cache" -mmin "-$_mins" 2>/dev/null)" ]; then
      PM_REPO=""; PM_BRANCH=""; PM_ROOTC=""; PM_INHERIT=""; PM_CACHE_HEAD=""
      . "$_cache" 2>/dev/null
      if [ "$PM_CACHE_HEAD" = "$_head" ] && [ -n "$PM_REPO" ] && [ -n "$PM_BRANCH" ]; then
        return 0
      fi
    fi
  fi

  PM_CTX="$( cd "$_root" 2>/dev/null && sh "$PM_SCRIPTS/pm-context.sh" 2>/dev/null )" || return 1
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

  # Nilai yang mengandung kutip tunggal tidak bisa ditulis aman ke file yang
  # akan di-source. Nama branch git boleh memuatnya, jadi kasus itu dilewati
  # dari cache alih-alih menghasilkan file yang rusak saat di-source.
  if [ -n "$_cache" ]; then
    case "$PM_REPO$PM_BRANCH$PM_ROOTC$PM_INHERIT$_head" in
      *"'"*) : ;;
      *)
        # Tulis ke file sementara lalu rename: dua hook bisa berjalan bersamaan,
        # dan pembaca tidak boleh pernah men-source file setengah tertulis.
        {
          printf "PM_REPO='%s'\n" "$PM_REPO"
          printf "PM_BRANCH='%s'\n" "$PM_BRANCH"
          printf "PM_ROOTC='%s'\n" "$PM_ROOTC"
          printf "PM_INHERIT='%s'\n" "$PM_INHERIT"
          printf "PM_CACHE_HEAD='%s'\n" "$_head"
        } > "$_cache.$$" 2>/dev/null &&
          mv -f "$_cache.$$" "$_cache" 2>/dev/null || rm -f "$_cache.$$" 2>/dev/null
        ;;
    esac
  fi
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
  #
  # Dilakukan dengan ekspansi parameter, bukan `sed`. Fungsi ini dipanggil di
  # setiap hook - termasuk PostToolUse yang berjalan pada setiap tool call - dan
  # satu proses `sed` di Windows berharga ~70 ms. Di jalur sepanas ini, pipeline
  # yang bisa diganti builtin memang harus diganti.
  PM_BASE="$PM_MEMORY_URL"
  while :; do case "$PM_BASE" in */) PM_BASE="${PM_BASE%/}" ;; *) break ;; esac; done
  case "$PM_BASE" in */mcp) PM_BASE="${PM_BASE%/mcp}" ;; esac
  while :; do case "$PM_BASE" in */) PM_BASE="${PM_BASE%/}" ;; *) break ;; esac; done
  [ -n "$PM_BASE" ]
}

pm_esc() {
  case "$1" in
    *' '*) printf '%s' "$1" | sed 's/ /%20/g' ;;
    *) printf '%s' "$1" ;;
  esac
}

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
  [ -d "$_dir" ] || mkdir -p "$_dir" 2>/dev/null
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
