#!/usr/bin/env sh
# touch-memory.sh - Retrieval tahap 3: memory diaktifkan oleh LOKASI FILE yang
# disentuh, bukan oleh direktori tempat sesi dimulai.
#
# Masalah yang dijawab: dua hook lain berhenti diam-diam kalau cwd sesi bukan
# repo git. Workspace payung yang berisi banyak repo terpisah - mini-ticast,
# dengan 13 sub-repo di bawahnya - persis bentuk itu, jadi memory tidak pernah
# dimuat meskipun pekerjaan nyatanya terjadi di dalam sub-repo yang punya
# memory. Gagalnya tanpa suara, jadi tidak ada yang menyadarinya.
#
# Hook ini berjalan setelah tool yang menyentuh file. Repo diturunkan dari path
# file itu, jadi sesi yang dibuka di mana pun - folder payung, atau repo lain
# sama sekali - tetap mendapat memory repo yang benar begitu ada filenya yang
# dibaca atau diubah.
#
# Kenapa PostToolUse dan bukan PreToolUse: PreToolUse kini juga menerima
# `additionalContext`, tapi Claude Code menaruhnya di titik yang sama - di
# samping hasil tool - jadi tidak ada yang lebih awal yang bisa didapat (stdout
# polos PreToolUse tetap hanya masuk debug log). Karena itu pemicunya
# menyertakan Read, bukan cuma Edit/Write - membaca file hampir selalu
# mendahului mengubahnya, jadi memory sudah masuk sebelum perubahan pertama
# ditulis.
#
# Briefing sebuah repo dikirim SEKALI per konteks (dicatat di pm_state_*),
# supaya ratusan pembacaan file tidak menjadi ratusan permintaan ke server.
# Konteks = agent induk, atau satu subagent: hook ini ikut berjalan di dalam
# subagent, dan subagent tidak melihat apa yang sudah diterima induknya.
set -u

PAYLOAD="$(cat 2>/dev/null)"
[ -n "$PAYLOAD" ] || exit 0

PM_SCRIPTS="$(dirname "$0")/../scripts"
. "$PM_SCRIPTS/pm-common.sh" 2>/dev/null || exit 0
pm_ready || exit 0

# --- path file dari stdin hook ----------------------------------------------
# Diurai dengan sed, bukan jq: jq tidak selalu ada, dan menjalankan node atau
# python di sini akan menambah puluhan milidetik pada SETIAP pembacaan file.
# Kalau pola tidak cocok, hook diam - itu jauh lebih baik daripada gagal ribut.
field() { pm_json_field "$PAYLOAD" "$1"; }

SESSION="$(field session_id)"
# Di dalam subagent, payload membawa agent_id. Dicek dengan `case` lebih dulu
# supaya jalur agent induk - yang berjalan di setiap tool call - tidak
# membayar satu pemanggilan sed tambahan.
AGENT=""
case "$PAYLOAD" in *'"agent_id"'*) AGENT="$(field agent_id)" ;; esac
TOOL="$(field tool_name)"
TARGET="$(field file_path)"
[ -n "$TARGET" ] || TARGET="$(field notebook_path)"

# Perubahan lewat Bash (heredoc, sed -i, tee) tidak punya field file_path.
# Satu-satunya petunjuk ada di dalam string perintahnya, jadi token yang
# berbentuk path dicoba satu per satu. Heuristik, dan memang boleh gagal:
# yang penting kasus Edit/Write di atas tidak ikut terpengaruh.
if [ -z "$TARGET" ] && [ "$TOOL" = "Bash" ]; then
  CMD="$(field command)"
  if [ -n "$CMD" ]; then
    # Set pemisah disusun dari potongan ber-kutip-tunggal supaya kutip ganda
    # dan kutip tunggal bisa ikut tanpa escape yang menyesatkan.
    PM_SEP='|;()&<>='
    PM_DQ='"'
    PM_SQ="'"
    for tok in $(printf '%s' "$CMD" | tr "$PM_SEP$PM_DQ$PM_SQ" ' '); do
      # Hanya token berbentuk path yang layak dicoba: ada pemisah direktori,
      # atau huruf drive Windows di depan.
      case "$tok" in */*|?:*) ;; *) continue ;; esac
      r="$(pm_repo_root "$tok" 2>/dev/null)" || continue
      [ -n "$r" ] && { TARGET="$tok"; break; }
    done
  fi
fi
[ -n "$TARGET" ] || exit 0

ROOT="$(pm_repo_root "$TARGET" 2>/dev/null)" || exit 0
[ -n "$ROOT" ] || exit 0

# --- sekali per repo per konteks --------------------------------------------
# `seen` dikunci per subagent: tanpa itu, repo yang sudah disentuh agent induk
# dilewati di setiap subagent, padahal subagent-lah (Explore, general-purpose)
# yang paling banyak membaca ulang kode. `active` tetap per sesi, jadi repo
# yang disentuh subagent ikut ditanyakan pada prompt induk berikutnya.
SEEN="$(pm_state_file "$SESSION${AGENT:+-$AGENT}" seen)"
ACTIVE="$(pm_state_file "$SESSION" active)"
pm_state_has "$ROOT" "$SEEN" && exit 0

# Klaim atomik. Claude sering membaca beberapa file sekaligus, dan hook
# PostToolUse-nya berjalan bersamaan: semuanya lolos pemeriksaan `seen` di atas
# sebelum ada yang sempat mencatat, lalu briefing yang sama tersuntik sekali per
# file - terlihat empat kali berturut-turut pada empat Read paralel
# (2026-09-28). `mkdir` atomik di semua platform, jadi hanya satu hook yang
# lolos. Direktorinya dibiarkan setelah berhasil - menghapusnya membuka lagi
# celah yang sama - dan dilepas hanya kalau server gagal dihubungi, supaya
# file berikutnya mencoba lagi.
pm_key "$ROOT"
CLAIM="$SEEN.claim-$PM_KEY"
mkdir "$CLAIM" 2>/dev/null || exit 0
unclaim() { rmdir "$CLAIM" 2>/dev/null; exit 0; }

pm_load_ctx "$ROOT" || unclaim

BUDGET="$(pm_budget "${PM_BRIEF_BUDGET:-}" 4000)"
BRIEF="$(curl -sf --max-time 6   -H "Authorization: Bearer $PM_MEMORY_TOKEN"   "$PM_BASE/brief?repo=$(pm_esc "$PM_REPO")&branch=$(pm_esc "$PM_BRANCH")&inherit=$(pm_esc "$PM_INHERIT")&budget=$BUDGET&mode=orientation&root=$PM_ROOTC"   2>/dev/null)" || unclaim
pm_is_html "$BRIEF" && unclaim

# Ditandai selesai SETELAH server menjawab, bukan sebelum. Dua kegagalan
# berbeda harus dibedakan di sini:
#
#   - server tak terjangkau (curl gagal, sudah keluar di atas): repo ini WAJIB
#     dicoba lagi pada file berikutnya, jangan dianggap selesai;
#   - server menjawab tapi repo ini belum punya memory (badan kosong): sudah
#     selesai. Kalau tidak dicatat, setiap pembacaan file di repo tanpa memory
#     akan memicu permintaan baru - ratusan permintaan untuk jawaban yang sama.
pm_state_add "$ROOT" "$SEEN"
[ -n "$BRIEF" ] || exit 0
pm_state_add "$ROOT" "$ACTIVE"

# `head -c` hanya dipanggil kalau briefingnya memang kepanjangan; panjang
# string sudah diketahui builtin, jadi jalur normalnya nol proses.
if [ "${#BRIEF}" -gt "$((BUDGET + 1500))" ]; then
  BRIEF="$(printf '%s' "$BRIEF" | head -c "$((BUDGET + 1500))")"
fi

# Subagent tidak menulis sendiri: temuannya dilaporkan ke agent induk, yang
# menyimpannya - supaya satu temuan tidak ditulis berkali-kali oleh beberapa
# subagent paralel, dan supaya subagent read-only seperti Explore tidak disuruh
# melakukan hal yang tidak bisa ia lakukan.
if [ -n "$AGENT" ]; then
  CLOSE="Kamu subagent: temuan mahal tentang repo ini yang tidak jelas dari
membaca satu file - termasuk entri yang ternyata salah - laporkan di jawabanmu
ke agent induk; agent induk yang menyimpannya ke memory tim."
else
  CLOSE="Penulisan ke memory TIDAK otomatis. Begitu ada temuan mahal tentang repo
ini yang tidak jelas dari membaca satu file, jalankan skill
\`/project-memory:simpan-memory\` untuk worktree di atas, supaya tulisannya
mendarat di repo ini."
fi

# Kalimat pembukanya dulu berbunyi "sesi ini dimulai di direktori lain", yang
# salah untuk sesi yang dibuka langsung di repo ini - dan versi sebelumnya
# memang mengirim briefing repo cwd dua kali, lengkap dengan klaim itu.
NOTE="Memory proyek untuk \`$PM_REPO\` @ \`$PM_BRANCH\` (worktree: $ROOT).

Dimuat otomatis karena ini pertama kalinya file di dalam repo itu disentuh di
konteks ini. Isi di bawah SUDAH ADA di konteksmu sekarang; jangan panggil tool
apa pun untuk mendapatkannya.

$BRIEF

$CLOSE"

printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"%s"}}\n' \
  "$(printf '%s' "$NOTE" | pm_json_escape)"
