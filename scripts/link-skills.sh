#!/usr/bin/env bash
set -euo pipefail

# Links all stable skills in the repository into local agent skill directories.
# Claude Code uses ~/.claude/skills; Codex can read ~/.codex/skills and the
# shared ~/.agents/skills location used by current Codex plugin installs.

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DESTS=(
  "$HOME/.claude/skills"
  "$HOME/.agents/skills"
  "$HOME/.codex/skills"
)

for dest in "${DESTS[@]}"; do
  # If a skills dir is a symlink that resolves into this repo, we'd end up
  # writing the per-skill symlinks back into the repo's own skills/ tree.
  # Detect and bail out instead of polluting the working copy.
  if [ -L "$dest" ]; then
    resolved="$(readlink -f "$dest")"
    case "$resolved" in
      "$REPO"|"$REPO"/*)
        echo "error: $dest is a symlink into this repo ($resolved)." >&2
        echo "Remove it (rm \"$dest\") and re-run; the script will recreate it as a real dir." >&2
        exit 1
        ;;
    esac
  fi

  mkdir -p "$dest"
done

find "$REPO/plugins" -name SKILL.md -not -path '*/node_modules/*' -not -path '*/deprecated/*' -not -path '*/in-progress/*' -print0 |
while IFS= read -r -d '' skill_md; do
  src="$(dirname "$skill_md")"
  name="$(basename "$src")"

  for dest in "${DESTS[@]}"; do
    target="$dest/$name"

    if [ -e "$target" ] && [ ! -L "$target" ]; then
      backup="${target}.backup-$(date +%Y%m%d%H%M%S)"
      mv "$target" "$backup"
      echo "backed up existing $target -> $backup"
    fi

    ln -sfn "$src" "$target"
    echo "linked $name -> $src ($dest)"
  done
done
