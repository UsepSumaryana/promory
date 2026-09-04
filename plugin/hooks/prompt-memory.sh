#!/usr/bin/env sh
# prompt-memory.sh - Retrieval tahap 2: entri memory yang RELEVAN dengan
# permintaan pengguna, disuntikkan setiap kali pengguna mengirim pesan.
#
# Kenapa di sini dan bukan di SessionStart: pada awal sesi belum ada permintaan,
# jadi relevansi tidak bisa dihitung dan satu-satunya pilihan adalah mengirim
# semuanya lalu memotong sewenang-wenang. Pada memory berskala ribuan entri itu
# tidak bisa dipertahankan. UserPromptSubmit berjalan setelah prompt ada.
#
# Stdin hook diteruskan APA ADANYA ke server. Mengurai JSON di shell POSIX tanpa
# jq itu rapuh terhadap escape dan baris baru, sementara server sudah punya
# parser yang benar - sekaligus di sanalah pelacakan "sudah pernah dikirim"
# berada, supaya prompt kedua tidak mengulang entri yang sama.
#
# REPO MANA yang ditanyakan tidak lagi ditentukan hanya oleh cwd. Versi
# sebelumnya berhenti diam-diam kalau cwd bukan repo git, sehingga sesi yang
# dibuka di workspace payung tidak pernah mendapat entri relevan meskipun
# pekerjaannya jelas berada di dalam sub-repo. Sekarang cwd hanya salah satu
# sumber; repo yang sudah diaktifkan oleh touch-memory.sh - karena ada filenya
# yang disentuh - ikut ditanyakan.
#
# Diam total kalau env belum diset, server tak terjangkau, atau tidak ada entri
# yang cocok. Prompt pengguna tidak boleh tertahan karena ini.
set -u

PAYLOAD="$(cat 2>/dev/null)"

PM_SCRIPTS="$(dirname "$0")/../scripts"
. "$PM_SCRIPTS/pm-common.sh" 2>/dev/null || exit 0
pm_ready || exit 0

SESSION="$(pm_json_field "$PAYLOAD" session_id)"
STATE="$(pm_state_file "$SESSION" active)"

# --- repo mana yang ditanyakan ----------------------------------------------
# cwd lebih dulu kalau memang repo, lalu repo yang diaktifkan lewat sentuhan
# file. Dibatasi tiga: sesi yang menyentuh belasan repo tidak boleh mengubah
# setiap prompt menjadi belasan permintaan.
TARGETS="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -f "$STATE" ]; then
  while IFS= read -r r; do
    [ -n "$r" ] || continue
    case "$TARGETS" in *"$r"*) continue ;; esac
    TARGETS="$TARGETS
$r"
  done < "$STATE"
fi
TARGETS="$(printf '%s\n' "$TARGETS" | sed '/^$/d' | head -3)"
[ -n "$TARGETS" ] || exit 0

BUDGET="$(pm_budget "${PM_RELEVANT_BUDGET:-}" 3000)"
MULTI=0
[ "$(printf '%s\n' "$TARGETS" | wc -l | tr -d ' ')" -gt 1 ] && MULTI=1

printf '%s\n' "$TARGETS" | while IFS= read -r ROOT; do
  [ -n "$ROOT" ] || continue
  pm_load_ctx "$ROOT" || continue

  OUT="$(printf '%s' "$PAYLOAD" | curl -sf --max-time 5 -X POST --data-binary @- \
    -H "Authorization: Bearer $PM_MEMORY_TOKEN" \
    -H 'Content-Type: application/json' \
    "$PM_BASE/relevant?repo=$(pm_esc "$PM_REPO")&branch=$(pm_esc "$PM_BRANCH")&inherit=$(pm_esc "$PM_INHERIT")&budget=$BUDGET&root=$PM_ROOTC" \
    2>/dev/null)" || continue

  [ -n "$OUT" ] || continue
  pm_is_html "$OUT" && continue

  # Kalau lebih dari satu repo ikut, tiap blok wajib diberi label. Tanpa itu
  # entri dua repo berbeda terbaca sebagai satu tumpukan, dan konvensi repo A
  # bisa diterapkan ke repo B.
  [ "$MULTI" = "1" ] && printf 'Memory `%s` @ `%s`:\n' "$PM_REPO" "$PM_BRANCH"
  printf '%s\n' "$OUT" | head -c "$((BUDGET + 800))"
  printf '\n'
done
