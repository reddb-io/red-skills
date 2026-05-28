#!/usr/bin/env bash
# One-shot migration from harness-level auto-memory to repo-versioned memory.
#
# Moves the harness-level auto-memory from
#   <harness-root>/<project-slug>/memory/
# into the repo at
#   <repo-root>/.red/memory/MEMORY.md
#   <repo-root>/.red/memory/memory/<slug>.md
# and replaces the original harness directory with a symlink pointing at
# <repo-root>/.red/memory, so the Claude Code system-prompt loader keeps
# resolving the same content.
#
# Idempotent: re-running on an already-migrated repo prints
# "already migrated, no-op" and exits 0 without touching any file.
#
# Usage:
#   memory-migrate-from-harness.sh \
#     [--harness-root <path>] \   # default: $HOME/.claude/projects
#     [--repo-root <path>]    \   # default: git rev-parse --show-toplevel
#     [--project-slug <slug>]     # default: derived from repo-root path
#
# Exit codes:
#   0  success or no-op
#   1  nothing to migrate (no harness dir and no in-repo memory data)
#   2  bad arguments

set -euo pipefail

harness_root="${HOME}/.claude/projects"
repo_root=""
project_slug=""

while [ $# -gt 0 ]; do
  case "$1" in
    --harness-root) harness_root="$2"; shift 2 ;;
    --repo-root)    repo_root="$2";    shift 2 ;;
    --project-slug) project_slug="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,21p' "$0"
      exit 0
      ;;
    *) printf 'unknown arg: %s\n' "$1" >&2; exit 2 ;;
  esac
done

if [ -z "$repo_root" ]; then
  repo_root="$(git rev-parse --show-toplevel)"
fi
repo_root="$(cd "$repo_root" && pwd)"

if [ -z "$project_slug" ]; then
  project_slug="$(printf '%s' "$repo_root" | sed 's|/|-|g')"
fi

harness_dir="$harness_root/$project_slug/memory"
target_dir="$repo_root/.red/memory"

# --- idempotency: harness already symlinked to the repo target ---------------
if [ -L "$harness_dir" ]; then
  current="$(readlink -f "$harness_dir" 2>/dev/null || true)"
  expected="$(readlink -f "$target_dir" 2>/dev/null || true)"
  if [ -n "$current" ] && [ -n "$expected" ] && [ "$current" = "$expected" ]; then
    printf 'already migrated, no-op\n'
    exit 0
  fi
fi

# --- locate source data ------------------------------------------------------
# Two acceptable starting states:
#   (a) harness_dir is a real directory with MEMORY.md inside     → copy then link
#   (b) target already populated (fresh clone, files came from git) → link only
have_harness_data=0
have_target_data=0

if [ -d "$harness_dir" ] && [ ! -L "$harness_dir" ] && [ -f "$harness_dir/MEMORY.md" ]; then
  have_harness_data=1
fi
if [ -f "$target_dir/MEMORY.md" ]; then
  have_target_data=1
fi

if [ "$have_harness_data" = 0 ] && [ "$have_target_data" = 0 ]; then
  printf 'error: nothing to migrate (no MEMORY.md at %s or %s)\n' \
    "$harness_dir" "$target_dir" >&2
  exit 1
fi

mkdir -p "$target_dir/memory"

# --- copy phase (only when target is empty and harness has the source) -------
if [ "$have_target_data" = 0 ] && [ "$have_harness_data" = 1 ]; then
  # MEMORY.md: rewrite bare per-fact links to the new memory/ subdir.
  # Matches links of the form ](<basename>.md) and rewrites to ](memory/<basename>.md).
  # The character class excludes '/', so paths that already include a directory
  # segment (e.g. memory/foo.md) are left alone.
  sed -E 's|\]\(([A-Za-z0-9_.-]+\.md)\)|](memory/\1)|g' \
    "$harness_dir/MEMORY.md" > "$target_dir/MEMORY.md"

  # Per-fact files: every *.md at the harness root except MEMORY.md itself.
  for f in "$harness_dir"/*.md; do
    [ -e "$f" ] || continue
    name="$(basename "$f")"
    [ "$name" = "MEMORY.md" ] && continue
    cp "$f" "$target_dir/memory/$name"
  done
fi

# --- symlink phase -----------------------------------------------------------
# Replace the harness dir with a symlink pointing at the repo's .red/memory.
# We only delete the harness directory after the target is known good.
if [ ! -f "$target_dir/MEMORY.md" ]; then
  printf 'error: post-copy sanity check failed: %s missing\n' \
    "$target_dir/MEMORY.md" >&2
  exit 1
fi

mkdir -p "$(dirname "$harness_dir")"

# Remove whatever is at $harness_dir (file, dir, broken symlink).
# We do NOT touch siblings under $(dirname "$harness_dir"); only the memory
# entry itself.
if [ -e "$harness_dir" ] || [ -L "$harness_dir" ]; then
  rm -rf "$harness_dir"
fi

ln -s "$target_dir" "$harness_dir"

printf 'migrated: %s -> %s\n' "$harness_dir" "$target_dir"
