#!/usr/bin/env bash
# lib/base-resolver.sh — resolve the effective base/merge branch for a work item.
#
# AFK bases each worktree on, and merges each finished item back into, a single
# branch. Three sources can name that branch; this module decides which one wins
# by a fixed precedence:
#
#   1. the branch-lock value — when the session is locked to a branch, the lock
#      is absolute and overrides any pin (the human pinned this checkout on
#      purpose; see misc/branch-lock/.../lock-store.sh, lock_store_read);
#   2. else the pinned branch — the issue/PRD `branch:` resolution
#      (lib/pin-reader.sh, pin_resolve);
#   3. else `main` — today's behaviour when nothing is set.
#
# Pure decision, no side effects: it touches neither git nor the filesystem and
# reads no globals. Callers read the lock file and resolve the pin themselves
# (the orchestrator owns that I/O) and pass both values in as strings, so the
# precedence stays unit-testable against fixed inputs
# (scripts/tests/base-resolver.test.sh). Wiring it into the merge path is a
# later slice — this module only decides.
#
# Public surface:
#   base_resolve <lock_value> <pin_value> [<default_branch>]
#     Echo the single effective branch by the precedence above and always
#     return 0. An empty (or whitespace-only) argument counts as "not set":
#       - a non-empty <lock_value> always wins, whatever the pin;
#       - else a non-empty <pin_value>;
#       - else <default_branch> (defaults to `main` when omitted or empty).
#     Note pin_resolve already collapses "no pin" to `main`, so passing its
#     output as <pin_value> is safe — the pin branch simply equals the default.

# _base_is_set <value>  — true when <value> has at least one non-whitespace char.
_base_is_set() {
  [[ -n "${1//[[:space:]]/}" ]]
}

# base_resolve <lock_value> <pin_value> [<default_branch>]
base_resolve() {
  local lock_value="${1:-}" pin_value="${2:-}" default_branch="${3:-}"
  _base_is_set "$default_branch" || default_branch="main"

  if _base_is_set "$lock_value"; then
    printf '%s\n' "$lock_value"
  elif _base_is_set "$pin_value"; then
    printf '%s\n' "$pin_value"
  else
    printf '%s\n' "$default_branch"
  fi
  return 0
}
