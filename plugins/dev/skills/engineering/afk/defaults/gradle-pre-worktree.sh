#!/usr/bin/env bash
# gradle-pre-worktree.sh — built-in pre_worktree default for Gradle projects.
#
# Contract (PRD #207, issue #211):
#   stdin   — JSON object: pre_worktree context (issue, target, branch, env).
#   stdout  — empty (context unchanged) when no build.gradle* is present at
#             $PROJECT_ROOT, OR when RED_AFK_GRADLE_USER_HOME_BASE is unset
#             (opt-in by env var — we do not claim a path on the user's
#             filesystem without their consent). Otherwise a JSON object
#             that merges {env: {GRADLE_USER_HOME: <slot dir>}} into ctx.
#   exit    — 0 on either branch. Never aborts the chain.
#
# Side effect: mkdir -p the slot Gradle home so daemons / caches are isolated
# between worker slots.
#
# Disable with `afk.hooks.defaults.gradle: false` in `.red/config.yaml`.

set -uo pipefail

project_root="${PROJECT_ROOT:-$(pwd)}"
ctx="$(cat || true)"
[[ -z "$ctx" ]] && ctx='{}'

shopt -s nullglob
matches=("$project_root"/build.gradle*)
shopt -u nullglob
if [[ "${#matches[@]}" -eq 0 ]]; then
  exit 0
fi

if [[ -z "${RED_AFK_GRADLE_USER_HOME_BASE:-}" ]]; then
  exit 0
fi

slot="${RED_AFK_SLOT:-0}"
home_dir="${RED_AFK_GRADLE_USER_HOME_BASE}/slot-${slot}"

mkdir -p "$home_dir" 2>/dev/null || true

printf '%s' "$ctx" | jq -c \
  --arg h "$home_dir" \
  '. + {env: ((.env // {}) + {GRADLE_USER_HOME: $h})}'
