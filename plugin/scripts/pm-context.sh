#!/usr/bin/env bash
# pm-context.sh — cetak identitas repo, branch, lineage, dan lokasi memory.
# Dipakai oleh agent project-memory. Read-only, tidak pernah menulis ke repo.
set -u

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "NOT_A_GIT_REPO"; exit 0; }

# Slug repo diturunkan dari URL remote, BUKAN dari nama direktori — dua orang
# yang meng-clone repo yang sama ke folder berbeda harus mendapat slug yang sama,
# atau memory mereka tidak akan pernah bertemu.
#
# Normalisasi menutup empat cara URL yang sama bisa tertulis berbeda: skema
# (https/ssh/scp), `user@`, nomor port, garis miring atau `.git` di ujung, dan
# beda huruf besar-kecil. Path lengkap setelah host dipertahankan, supaya dua
# repo bernama sama di subgrup berbeda tidak saling menimpa.
slug() {
  echo "$1" \
    | tr 'A-Z' 'a-z' \
    | sed -e 's#^[a-z][a-z0-9+.-]*://##' \
          -e 's#^[^@/]*@##' \
          -e 's#^\([^/:]*\):[0-9][0-9]*/#\1/#' \
          -e 's#^\([^/:]*\):#\1/#' \
          -e 's#/*$##' \
          -e 's#\.git$##' \
          -e 's#^[^/]*/##' \
          -e 's#[^a-z0-9._/-]#-#g' \
          -e 's#/#-#g'
}

# origin lebih dulu, lalu upstream, lalu remote apa pun yang ada.
REMOTE_URL=""; REMOTE_NAME=""
for r in origin upstream $(git remote 2>/dev/null); do
  u="$(git remote get-url "$r" 2>/dev/null)" || continue
  [ -n "$u" ] && { REMOTE_URL="$u"; REMOTE_NAME="$r"; break; }
done

if [ -n "$REMOTE_URL" ]; then
  REPO="$(slug "$REMOTE_URL")"
  SLUG_SOURCE="remote:$REMOTE_NAME"
else
  # Tanpa remote, satu-satunya nama yang tersisa adalah nama folder — dan itu
  # berbeda antar orang. Ditandai eksplisit supaya agent bisa memperingatkan
  # bahwa memory ini tidak akan menyatu dengan milik rekan.
  REPO="$(basename "$ROOT" | tr 'A-Z' 'a-z' | sed 's#[^a-z0-9._-]#-#g')"
  SLUG_SOURCE="fallback-nama-direktori"
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
BSLUG="$(echo "$BRANCH" | sed 's#[^A-Za-z0-9._-]#-#g')"

echo "repo_slug: $REPO"
echo "repo_slug_source: $SLUG_SOURCE"
[ -n "$REMOTE_URL" ] && echo "remote_url: $REMOTE_URL"
[ "$SLUG_SOURCE" = "fallback-nama-direktori" ] && echo "PERINGATAN: repo tanpa remote — slug diambil dari nama folder, jadi memory tidak akan menyatu dengan rekan yang memakai nama folder berbeda."
echo "worktree: $ROOT"
echo "branch: $BRANCH"
echo "branch_slug: $BSLUG"

# --- parent branch: branch lain yang paling baru divergen dari HEAD ---
BEST=""; BESTN=""
for b in $(git for-each-ref --format='%(refname:short)' refs/heads refs/remotes 2>/dev/null | grep -v 'HEAD$'); do
  [ "$b" = "$BRANCH" ] && continue
  [ "$b" = "origin/$BRANCH" ] && continue
  mb="$(git merge-base HEAD "$b" 2>/dev/null)" || continue
  [ -z "$mb" ] && continue
  n="$(git rev-list --count "$mb..HEAD" 2>/dev/null)" || continue
  [ "$n" = "0" ] && continue
  if [ -z "$BESTN" ] || [ "$n" -lt "$BESTN" ]; then BESTN="$n"; BEST="$b"; fi
done
echo "parent_branch: ${BEST:-unknown}"
echo "commits_since_fork: ${BESTN:-0}"
[ -n "$BEST" ] && echo "fork_point: $(git merge-base HEAD "$BEST")"

# --- branch yang sudah memuat seluruh isi branch ini (HEAD adalah ancestor-nya) ---
# Loop parent di atas melewatkan kandidat dengan ahead=0, dan justru itulah tanda
# bahwa pekerjaan branch ini sudah ter-merge ke sana.
echo "contained_by:"
FOUND=0
for b in $(git for-each-ref --format='%(refname:short)' refs/heads refs/remotes 2>/dev/null | grep -v 'HEAD$'); do
  [ "$b" = "$BRANCH" ] && continue
  git merge-base --is-ancestor HEAD "$b" 2>/dev/null && { echo "  - $b"; FOUND=1; }
done
[ "$FOUND" = "0" ] && echo "  (none)"

# --- branch yang pernah di-merge masuk ke branch ini ---
echo "merged_in:"
git log --merges --first-parent -30 --format='  - %h %s (%ad)' --date=short HEAD 2>/dev/null \
  | grep -iE "merge (branch|pull request|remote-tracking)" || echo "  (none)"

# --- state kerja saat ini ---
echo "head: $(git log -1 --format='%h %s' 2>/dev/null)"
echo "dirty_files: $(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"

