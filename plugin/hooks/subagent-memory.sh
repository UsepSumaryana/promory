#!/usr/bin/env sh
# subagent-memory.sh - memory untuk subagent, disuntikkan saat subagent dimulai.
#
# Subagent tidak pernah melewati dua jalur utama: SessionStart hanya berjalan
# untuk sesi, dan UserPromptSubmit hanya untuk prompt pengguna - tugas yang
# ditulis agent induk untuk subagent bukan prompt pengguna. Padahal subagent
# seperti Explore dan general-purpose justru yang paling banyak membaca ulang
# codebase, persis pekerjaan yang ingin dipangkas memory ini. Sebelum hook ini
# ada, satu-satunya memory yang bisa sampai ke subagent adalah briefing dari
# touch-memory.sh - dan itu pun dilewati untuk setiap repo yang sudah pernah
# disentuh agent induk.
#
# Yang dikirim, per repo (cwd dan repo yang aktif di sesi ini, paling banyak
# tiga - daftar yang sama dengan prompt-memory.sh):
#
#   - entri yang SUDAH diterima agent induk di sesi ini. Server menyimpan
#     daftarnya untuk dedup /relevant, dan entri itulah yang paling mungkin
#     menyangkut tugas yang sedang didelegasikan;
#   - orientasi repo: peta isi memory, entri ber-pin, ADR yang mengikat.
#
# Input SubagentStart tidak memuat teks tugas subagent, jadi relevansi tidak
# bisa dihitung ulang di sini; karena itu yang dipakai adalah warisan induknya.
#
# Repo yang dikirim di sini dicatat di state `seen` milik subagent itu, supaya
# touch-memory.sh tidak mengirim briefing yang sama lagi begitu subagent membaca
# file pertamanya. Server lama belum mengenal mode=subagent dan jatuh ke
# orientasi biasa - subagent tetap mendapat peta, tanpa entri warisan.
set -u

PAYLOAD="$(cat 2>/dev/null)"
[ -n "$PAYLOAD" ] || exit 0

PM_SCRIPTS="$(dirname "$0")/../scripts"
. "$PM_SCRIPTS/pm-common.sh" 2>/dev/null || exit 0
pm_ready || exit 0

SESSION="$(pm_json_field "$PAYLOAD" session_id)"
AGENT="$(pm_json_field "$PAYLOAD" agent_id)"
[ -n "$AGENT" ] || exit 0

# Subagent yang pekerjaannya bukan kode repo ini tidak perlu membawa memory-nya:
# pemandu dokumentasi Claude Code, penyetel status line, agent milik plugin ini
# sendiri (mengambil memory lewat memory_recall), dan fork - yang mewarisi
# seluruh konteks induk, termasuk memory yang sudah ada di sana.
case "$(pm_json_field "$PAYLOAD" agent_type)" in
  claude-code-guide|statusline-setup|fork|project-memory:*) exit 0 ;;
esac

pm_targets "$(pm_state_file "$SESSION" active)"
[ -n "$PM_TARGETS" ] || exit 0
SEEN="$(pm_state_file "$SESSION-$AGENT" seen)"

# Anggaran TOTAL, dibagi rata antar repo. Claude Code memotong additionalContext
# di atas 10.000 karakter menjadi pratinjau 2.000 karakter plus path file yang
# tidak disuruh dibaca - jadi batas atasnya dijaga di bawah itu, termasuk
# pembungkus dan label tiap repo.
TOTAL="$(pm_budget "${PM_SUBAGENT_BUDGET:-}" 6000)"
[ "$TOTAL" -gt 8000 ] && TOTAL=8000
BUDGET=$((TOTAL / PM_NTARGET))
LIMIT=$((BUDGET + 500))

BODY=""
while IFS= read -r ROOT; do
  [ -n "$ROOT" ] || continue
  pm_load_ctx "$ROOT" || continue

  OUT="$(curl -sf --max-time 5 \
    -H "Authorization: Bearer $PM_MEMORY_TOKEN" \
    "$PM_BASE/brief?repo=$(pm_esc "$PM_REPO")&branch=$(pm_esc "$PM_BRANCH")&inherit=$(pm_esc "$PM_INHERIT")&budget=$BUDGET&mode=subagent&session=$(pm_esc "$SESSION")&root=$PM_ROOTC" \
    2>/dev/null)" || continue
  pm_is_html "$OUT" && continue

  # Aturan yang sama dengan touch-memory.sh: `seen` begitu server menjawab,
  # termasuk jawaban kosong untuk repo yang belum punya memory.
  pm_state_add "$ROOT" "$SEEN"
  [ -n "$OUT" ] || continue

  if [ "${#OUT}" -gt "$LIMIT" ]; then
    OUT="$(printf '%s' "$OUT" | head -c "$LIMIT")"
  fi
  # Selalu berlabel, bahkan untuk satu repo: di konteks subagent tidak ada
  # pembungkus lain yang menyebut repo mana isi ini berlaku.
  BODY="$BODY

# Memory \`$PM_REPO\` @ \`$PM_BRANCH\` (worktree: $ROOT)

$OUT"
done <<PM_TARGETS_EOF
$PM_TARGETS
PM_TARGETS_EOF
[ -n "$BODY" ] || exit 0

NOTE="Memory tim dari plugin project-memory untuk repo yang sedang dikerjakan
agent induk, dimuat otomatis saat subagent ini dimulai. Isinya sudah ada di
konteks ini tanpa perlu pemanggilan tool.$BODY

Entri bertanda PERIKSA ULANG sudah cukup tua untuk mungkin tidak akurat lagi;
cocokkan ke kode sebelum mengandalkannya. Temuan mahal yang tidak jelas dari
membaca satu file - termasuk entri yang ternyata salah - laporkan di jawabanmu
ke agent induk; agent induk yang menyimpannya ke memory tim."

printf '{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"%s"}}\n' \
  "$(printf '%s' "$NOTE" | pm_json_escape)"
