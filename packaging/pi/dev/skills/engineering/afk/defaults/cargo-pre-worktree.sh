#!/usr/bin/env bash
# cargo-pre-worktree.sh — built-in pre_worktree default for Rust projects.
#
# Contract (PRD #207, issue #211):
#   stdin   — JSON object: pre_worktree context (issue, target, branch, env).
#   stdout  — empty (context unchanged) when no Cargo.toml is present at
#             $PROJECT_ROOT, OR a JSON object that merges
#             {env: {CARGO_TARGET_DIR: <slot dir>}} into the context.
#   exit    — 0 on either branch. Never aborts the chain.
#
# Side effect: mkdir -p the slot target dir so cargo can use it immediately.
# CARGO_TARGET_DIR=${RED_AFK_CARGO_TARGET_BASE:-/opt/cargo-target}/slot-${RED_AFK_SLOT:-0}
# so each worker slot gets its own target directory and Cargo never
# serializes on .cargo-lock between workers.
#
# Disable with `afk.hooks.defaults.cargo: false` in `.red/config.yaml`.

set -uo pipefail

project_root="${PROJECT_ROOT:-$(pwd)}"
ctx="$(timeout "${RED_SKILLS_HOOK_STDIN_TIMEOUT_S:-5s}" cat 2>/dev/null || true)"
[[ -z "$ctx" ]] && ctx='{}'

if [[ ! -f "$project_root/Cargo.toml" ]]; then
  # Not a Rust project — pass-through.
  exit 0
fi

slot="${RED_AFK_SLOT:-0}"
base="${RED_AFK_CARGO_TARGET_BASE:-/opt/cargo-target}"
target_dir="${base}/slot-${slot}"

mkdir -p "$target_dir" 2>/dev/null || true

printf '%s' "$ctx" | jq -c \
  --arg t "$target_dir" \
  '. + {env: ((.env // {}) + {CARGO_TARGET_DIR: $t})}'
