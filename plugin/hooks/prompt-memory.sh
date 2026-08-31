#!/usr/bin/env sh
# Retrieval tahap 2: menyuntikkan entri memory yang RELEVAN dengan permintaan
# pengguna, setiap kali pengguna mengirim pesan.
#
# Kenapa di sini dan bukan di SessionStart: pada awal sesi belum ada permintaan,
# jadi relevansi tidak bisa dihitung dan satu-satunya pilihan adalah mengirim
# semuanya lalu memotong sewenang-wenang. Pada memory berskala ribuan entri itu
# tidak bisa dipertahankan. UserPromptSubmit berjalan setelah prompt ada.
#
# Stdin hook diteruskan APA ADANYA ke server. Mengurai JSON di shell POSIX tanpa
# jq itu rapuh terhadap escape dan baris baru, sementara server sudah punya
# parser yang benar — sekaligus di sanalah pelacakan "sudah pernah dikirim"
# berada, supaya prompt kedua tidak mengulang entri yang sama.
#
# Diam total kalau bukan repo git, env belum diset, server tak terjangkau, atau
# tidak ada entri yang cocok. Prompt pengguna tidak boleh tertahan karena ini.

command -v curl >/dev/null 2>&1 || exit 0
git rev-parse --show-toplevel >/dev/null 2>&1 || exit 0
[ -n "${PM_MEMORY_URL:-}" ] || exit 0
[ -n "${PM_MEMORY_TOKEN:-}" ] || exit 0

CTX="$(sh "$(dirname "$0")/../scripts/pm-context.sh" 2>/dev/null)" || exit 0
field() { echo "$CTX" | sed -n "s/^$1: //p" | head -1; }

REPO="$(field repo_slug)"
# Identitas stabil lintas clone; server memakainya untuk menyatukan slug yang
# berbeda pada repo git yang sama.
ROOTC="$(field repo_root_commit)"
case "$ROOTC" in *[!0-9a-f]*|"") ROOTC="" ;; esac
BRANCH="$(field branch)"
[ -n "$REPO" ] && [ -n "$BRANCH" ] || exit 0

PARENT="$(field parent_branch)"
[ "$PARENT" = "unknown" ] && PARENT=""
MERGED="$(echo "$CTX" | sed -n "/^merged_in:/,/^[a-z_]*:/p" \
  | sed -n "s/.*Merge branch '\([^']*\)'.*/\1/p" | sort -u | tr '\n' ',' | sed 's/,$//')"
INHERIT="$(echo "$PARENT,$MERGED" | sed 's/^,//; s/,$//')"

BASE="$(echo "$PM_MEMORY_URL" | sed 's#/mcp/*$##; s#/*$##')"
BUDGET="${PM_RELEVANT_BUDGET:-3000}"
case "$BUDGET" in ''|*[!0-9]*) BUDGET=3000 ;; esac

esc() { echo "$1" | sed 's/ /%20/g'; }

OUT="$(curl -sf --max-time 5 -X POST --data-binary @- \
  -H "Authorization: Bearer $PM_MEMORY_TOKEN" \
  -H 'Content-Type: application/json' \
  "$BASE/relevant?repo=$(esc "$REPO")&branch=$(esc "$BRANCH")&inherit=$(esc "$INHERIT")&budget=$BUDGET&root=$ROOTC" \
  2>/dev/null)" || exit 0

[ -n "$OUT" ] || exit 0
case "$OUT" in *'<html'*|*'<!DOCTYPE'*|*'<HTML'*) exit 0 ;; esac

printf '%s\n' "$OUT" | head -c "$((BUDGET + 800))"
