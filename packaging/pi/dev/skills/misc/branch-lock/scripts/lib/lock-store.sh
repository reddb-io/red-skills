#!/usr/bin/env bash
# lib/lock-store.sh — the Lock Store: owns the branch-lock.yaml file end to end,
# following the pure / explicit-args contract of the afk lib/ modules.
#
# The lock file records the single branch the agent is pinned to in the primary
# checkout. Its presence means "locked"; its absence means "unlocked". Content
# is the branch name on one line (a bare YAML scalar — valid YAML, trivially
# inspectable). It lives under the gitignored .red/tmp/ so every checkout and
# machine locks independently and nothing is ever committed.
#
# Reads no globals. The lock-file path is a parameter on every call, so the
# Module stays unit-testable by sourcing it directly. Writes are atomic
# (temp-in-same-dir then mv) so a concurrent reader never sees a half-written
# file and a relock can never leave the target empty.
#
# Public surface:
#   lock_store_write <lockfile> <branch>
#     Atomically writes <branch> as the lock target. Creates the parent dir if
#     missing. Returns 2 on missing arguments.
#
#   lock_store_read <lockfile>
#     Echoes the locked branch name (trailing whitespace stripped) and returns
#     0 when locked. Prints nothing and returns 1 when the file is absent
#     (= unlocked), so absence is strictly opt-out.
#
#   lock_store_clear <lockfile>
#     Removes the lock file. Idempotent — returns 0 whether or not it existed.
#
#   lock_store_is_locked <lockfile>
#     Returns 0 when a non-empty lock file is present, 1 otherwise. No output.

# lock_store_write <lockfile> <branch>
lock_store_write() {
  local _path="$1" _branch="$2"
  [[ -z "$_path" || -z "$_branch" ]] && { printf '[lock-store] lock_store_write: need <lockfile> <branch>\n' >&2; return 2; }
  mkdir -p "$(dirname "$_path")"
  local tmp
  tmp="$(mktemp "$(dirname "$_path")/.branch-lock.XXXXXX")"
  printf '%s\n' "$_branch" > "$tmp"
  mv -f "$tmp" "$_path"
}

# lock_store_read <lockfile>
lock_store_read() {
  local _path="$1"
  [[ -s "$_path" ]] || return 1
  local branch
  # strip trailing whitespace/newlines; keep the first line only
  IFS= read -r branch < "$_path"
  branch="${branch%"${branch##*[![:space:]]}"}"
  [[ -n "$branch" ]] || return 1
  printf '%s' "$branch"
}

# lock_store_clear <lockfile>
lock_store_clear() {
  local _path="$1"
  [[ -z "$_path" ]] && { printf '[lock-store] lock_store_clear: need <lockfile>\n' >&2; return 2; }
  rm -f "$_path"
  return 0
}

# lock_store_is_locked <lockfile>
lock_store_is_locked() {
  local _path="$1"
  lock_store_read "$_path" >/dev/null 2>&1
}
