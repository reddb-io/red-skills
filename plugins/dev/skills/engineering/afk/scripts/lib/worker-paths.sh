#!/usr/bin/env bash
# lib/worker-paths.sh — the one place that owns the AFK worker directory scheme.
#
# Every AFK attempt lives on disk under an attempt-first tree (PRD #244):
#
#   <root>/workers/<worker>/<issue>-a<attempt>/
#                                              └── worktree/   (lives inside)
#
# `worker`, `issue`, and `attempt` are each first-class path segments, so an
# operator can see everything one worker did across issues, and every retry is
# its own `{issue}-a{n}/` directory instead of overwriting itself.
#
# This module is the single source of truth for that layout: it builds a path
# from a `(worker, issue, attempt)` identity, parses the identity back out of a
# path (round-tripping with the builder), and exposes the canonical globs the
# rest of the system needs. Nothing else should construct these paths by hand
# (PRD #244, story 26).
#
# These functions are pure text predicates: no `gh`, no git, no filesystem
# access (the globs are returned as literal patterns, not expanded), so the
# whole surface stays unit-testable against fixed strings
# (scripts/tests/worker-paths.test.sh).
#
# Identity grammar:
#   worker   — a worker id token, e.g. `wA1B9`. Non-empty, drawn from
#              [A-Za-z0-9_-] (no slashes, so it is always a single path segment).
#   issue    — a positive integer issue number, no leading zeros beyond `0`
#              itself being rejected (issues start at 1).
#   attempt  — a positive integer run counter (per-worker, per-issue), >= 1.
#
# Public surface:
#   worker_paths_build <root> <worker> <issue> <attempt>
#     Echo `<root>/workers/<worker>/<issue>-a<attempt>`. Returns 0 on a valid
#     identity, or non-zero with no output when any component is malformed.
#
#   worker_paths_parse <path>
#     Echo `<worker> <issue> <attempt>` (space-separated, one line) parsed from
#     the trailing `workers/<worker>/<issue>-a<attempt>` segments of <path>.
#     Returns 0 iff <path> matches the scheme; otherwise non-zero, no output.
#     Round-trips with worker_paths_build.
#
#   worker_paths_issue_glob <root> <issue>
#     Echo the canonical glob matching every attempt of one issue across all
#     workers: `<root>/workers/*/<issue>-a*`. Returns 0 on a valid issue.
#
#   worker_paths_workers_glob <root>
#     Echo the canonical glob matching all live worker directories:
#     `<root>/workers/*`. Returns 0 on a non-empty <root>, else non-zero.

# _worker_paths_valid_worker <token>
# True iff <token> is a single non-empty path segment of [A-Za-z0-9_-].
_worker_paths_valid_worker() {
  [[ "$1" =~ ^[A-Za-z0-9_-]+$ ]]
}

# _worker_paths_valid_number <token>
# True iff <token> is a positive integer (>= 1), no sign, no leading zeros.
_worker_paths_valid_number() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

# worker_paths_build <root> <worker> <issue> <attempt>
worker_paths_build() {
  local root="$1" worker="$2" issue="$3" attempt="$4"
  [[ -n "$root" ]] || return 1
  _worker_paths_valid_worker "$worker" || return 1
  _worker_paths_valid_number "$issue" || return 1
  _worker_paths_valid_number "$attempt" || return 1
  # Normalise a single trailing slash on root so build("dir/") and build("dir")
  # produce the same path.
  root="${root%/}"
  printf '%s/workers/%s/%s-a%s\n' "$root" "$worker" "$issue" "$attempt"
  return 0
}

# worker_paths_parse <path>
worker_paths_parse() {
  local path="$1" leaf worker parent issue attempt
  [[ -n "$path" ]] || return 1
  # Strip a single trailing slash so a path with or without it parses the same.
  path="${path%/}"
  leaf="${path##*/}"
  # The leaf must be exactly `<issue>-a<attempt>` with positive integers.
  [[ "$leaf" =~ ^([1-9][0-9]*)-a([1-9][0-9]*)$ ]] || return 1
  issue="${BASH_REMATCH[1]}"
  attempt="${BASH_REMATCH[2]}"
  # The segment above the leaf is the worker id; its own parent must be `workers`.
  path="${path%/*}"
  worker="${path##*/}"
  _worker_paths_valid_worker "$worker" || return 1
  path="${path%/*}"
  parent="${path##*/}"
  [[ "$parent" == "workers" ]] || return 1
  printf '%s %s %s\n' "$worker" "$issue" "$attempt"
  return 0
}

# worker_paths_issue_glob <root> <issue>
worker_paths_issue_glob() {
  local root="$1" issue="$2"
  [[ -n "$root" ]] || return 1
  _worker_paths_valid_number "$issue" || return 1
  root="${root%/}"
  printf '%s/workers/*/%s-a*\n' "$root" "$issue"
  return 0
}

# worker_paths_workers_glob <root>
worker_paths_workers_glob() {
  local root="$1"
  [[ -n "$root" ]] || return 1
  root="${root%/}"
  printf '%s/workers/*\n' "$root"
  return 0
}
