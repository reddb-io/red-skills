#!/bin/sh
# scripts/install-git-hooks.sh — install the repo-tracked git hooks in
# scripts/git-hooks/ into the local .git/hooks/ dir.
#
# Idempotent — safe to re-run. Existing hooks of the same name are OVERWRITTEN
# (the tracked copy is the source of truth; if you have a local customisation,
# edit scripts/git-hooks/<name> and re-run this).
#
# Why this exists: AFK worker worktrees (`git worktree add` from
# feedback-worktree.ts) need submodules + pnpm install at worktree-creation
# time. CI gets this from `actions/checkout submodules:recursive`; a local
# checkout needs a post-checkout hook to do the same. Tracking the hook in the
# repo + shipping an installer means a fresh clone (or a contributor's first
# pull) gets the right shape immediately, no manual hook copying required.

set -eu

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOKS_SRC="$REPO_ROOT/scripts/git-hooks"
HOOKS_DST="$REPO_ROOT/.git/hooks"

if [ ! -d "$HOOKS_DST" ]; then
  echo "error: $HOOKS_DST is not a directory — is this a git repo?" >&2
  exit 1
fi

if [ ! -d "$HOOKS_SRC" ]; then
  echo "error: $HOOKS_SRC is not a directory — repo layout changed?" >&2
  exit 1
fi

installed=0
for src in "$HOOKS_SRC"/*; do
  [ -f "$src" ] || continue
  name="$(basename "$src")"
  dst="$HOOKS_DST/$name"
  cp "$src" "$dst"
  chmod +x "$dst"
  echo "installed $name"
  installed=$((installed + 1))
done

if [ "$installed" -eq 0 ]; then
  echo "no hooks found in $HOOKS_SRC" >&2
  exit 1
fi

echo "$installed hook(s) installed. Re-run this script after editing any file in scripts/git-hooks/."
