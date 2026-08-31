#!/usr/bin/env bash
# pm-context.sh — cetak identitas repo, branch, lineage, dan lokasi memory.
# Dipakai oleh agent project-memory. Read-only, tidak pernah menulis ke repo.
set -u

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "NOT_A_GIT_REPO"; exit 0; }

slug() { echo "$1" | sed -e 's#^.*[:/]\([^/]*/[^/]*\)$#\1#' -e 's#\.git$##' -e 's#[^A-Za-z0-9._-]#-#g'; }

ORIGIN="$(git remote get-url origin 2>/dev/null)"
if [ -n "$ORIGIN" ]; then REPO="$(slug "$ORIGIN")"; else REPO="$(basename "$ROOT" | sed 's#[^A-Za-z0-9._-]#-#g')"; fi

BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
BSLUG="$(echo "$BRANCH" | sed 's#[^A-Za-z0-9._-]#-#g')"
STORE="$HOME/.claude/project-memory/$REPO"

echo "repo_slug: $REPO"
echo "worktree: $ROOT"
echo "branch: $BRANCH"
echo "branch_slug: $BSLUG"
echo "store_dir: $STORE"
echo "shared_file: $STORE/_shared.md"
echo "branch_file: $STORE/branches/$BSLUG.md"
echo "lineage_file: $STORE/branches/$BSLUG.lineage.json"

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

echo "existing_memory:"
if [ -d "$STORE" ]; then
  find "$STORE" -name '*.md' -printf '  - %P (%s bytes)\n' 2>/dev/null | sort || echo "  (none)"
else
  echo "  (store belum ada)"
fi
