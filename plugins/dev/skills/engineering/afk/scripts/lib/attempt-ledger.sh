#!/usr/bin/env bash
# lib/attempt-ledger.sh — derive the next attempt number and assemble the
# restart-informed context for a new AFK attempt (PRD #244, issue #249).
#
# Every AFK attempt lives on disk under the attempt-first tree owned by
# lib/worker-paths.sh:
#
#   <root>/workers/<worker>/<issue>-a<attempt>/
#
# When the orchestrator is about to (re)spawn a worker on an issue it needs two
# things this module provides:
#
#   1. the NEXT attempt number — one past the highest attempt already on disk
#      for that issue (1 when none exists yet); and
#   2. the RESTART CONTEXT for that next attempt — the previous attempt's remote
#      snapshot branch reference and its recorded failure reason, packaged so the
#      inner agent can inspect what the last run left behind instead of starting
#      blind.
#
# This is the one place that READS the attempt tree. It is the FS-enumeration
# consumer of worker-paths: worker-paths owns the *grammar* (it builds and
# parses paths and returns canonical glob *patterns* as literal strings, never
# touching disk), and this module expands `worker_paths_issue_glob` against the
# real filesystem and parses each hit back with `worker_paths_parse`. Path
# shapes therefore live in exactly one module; enumeration lives here.
#
# Per-attempt outcome contract (read-only here; written by the reap/envelope
# path in a later wiring slice): an attempt directory MAY carry two plain-text
# marker files —
#   <attempt_dir>/snapshot-branch.ref   one line: the remote snapshot branch ref
#                                       (e.g. `afk-attempts/<wid>/<issue>-slug`).
#   <attempt_dir>/failure.reason        free text: the recorded failure reason
#                                       (status / error class / summary line).
# Both are optional; a missing file degrades to a labelled "(none)" placeholder
# rather than an error, so a kill before either was written still yields a
# usable context block.
#
# Dependency: lib/worker-paths.sh. Sourced relatively if its functions are not
# already present, so this module works both inside the orchestrator (where
# worker-paths is already sourced) and standalone in tests.
#
# Public surface:
#   attempt_ledger_next_number <root> <issue>
#     Echo the next attempt number for <issue>: (highest existing attempt on
#     disk) + 1, or 1 when none exists. Returns 0 on a valid (root, issue);
#     non-zero with no output when either is malformed (delegated to
#     worker-paths validation).
#
#   attempt_ledger_prev_dir <root> <issue>
#     Echo the directory path of the highest-numbered existing attempt for
#     <issue> (the previous attempt). Returns 0 when one exists; non-zero with
#     no output when there is no prior attempt (the first-attempt signal) or the
#     identity is malformed.
#
#   attempt_ledger_context <root> <issue>
#     Echo a restart-context block for the next attempt, assembled from the
#     previous attempt's directory:
#       prev-attempt: <N>
#       prev-snapshot-branch: <ref | (none)>
#       prev-failure-reason:
#       <verbatim failure.reason | (none recorded)>
#     Returns 0 when a prior attempt exists; non-zero with no output on the
#     first attempt (nothing to restart from) or a malformed identity.

# Source worker-paths if its grammar functions are not already in scope.
if ! declare -F worker_paths_issue_glob >/dev/null 2>&1; then
  _attempt_ledger_self="${BASH_SOURCE[0]}"
  _attempt_ledger_libdir="$(cd "$(dirname "$_attempt_ledger_self")" && pwd)"
  # shellcheck source=./worker-paths.sh
  source "$_attempt_ledger_libdir/worker-paths.sh"
  unset _attempt_ledger_self _attempt_ledger_libdir
fi

# _attempt_ledger_highest <root> <issue>
# Echo `<attempt> <dir>` for the highest-numbered existing attempt of <issue>
# across all workers, by expanding the worker-paths issue glob against the FS
# and parsing each hit. Echoes nothing when there is no valid attempt dir.
# Returns 0 iff a prior attempt was found; non-zero (and no output) otherwise,
# including a malformed identity (the glob builder rejects it).
_attempt_ledger_highest() {
  local root="$1" issue="$2" glob
  glob="$(worker_paths_issue_glob "$root" "$issue")" || return 1

  local best_attempt=0 best_dir="" dir parsed attempt
  # The glob is a literal pattern from worker-paths; expand it here. `nullglob`
  # keeps the loop from running once on the unexpanded pattern when nothing
  # matches. Scope the shell option change to this function only.
  local _had_nullglob=0
  shopt -q nullglob && _had_nullglob=1
  shopt -s nullglob
  for dir in $glob; do
    [[ -d "$dir" ]] || continue
    # worker_paths_parse echoes `<worker> <issue> <attempt>`; it rejects any
    # directory that does not match the scheme (e.g. a non-numeric suffix).
    parsed="$(worker_paths_parse "$dir")" || continue
    attempt="${parsed##* }"
    if (( attempt > best_attempt )); then
      best_attempt="$attempt"
      best_dir="$dir"
    fi
  done
  (( _had_nullglob )) || shopt -u nullglob

  [[ -n "$best_dir" ]] || return 1
  printf '%s %s\n' "$best_attempt" "$best_dir"
  return 0
}

# attempt_ledger_next_number <root> <issue>
attempt_ledger_next_number() {
  local root="$1" issue="$2" highest attempt
  # Validate the identity up front via the glob builder; a bad root/issue means
  # we cannot derive anything, so fail rather than guessing.
  worker_paths_issue_glob "$root" "$issue" >/dev/null || return 1

  if highest="$(_attempt_ledger_highest "$root" "$issue")"; then
    attempt="${highest%% *}"
    printf '%s\n' "$(( attempt + 1 ))"
  else
    # No prior attempt on disk — this is the first attempt.
    printf '1\n'
  fi
  return 0
}

# attempt_ledger_prev_dir <root> <issue>
attempt_ledger_prev_dir() {
  local root="$1" issue="$2" highest
  highest="$(_attempt_ledger_highest "$root" "$issue")" || return 1
  printf '%s\n' "${highest#* }"
  return 0
}

# attempt_ledger_context <root> <issue>
attempt_ledger_context() {
  local root="$1" issue="$2" highest attempt dir
  highest="$(_attempt_ledger_highest "$root" "$issue")" || return 1
  attempt="${highest%% *}"
  dir="${highest#* }"

  local branch="(none)" reason
  if [[ -s "$dir/snapshot-branch.ref" ]]; then
    # The ref is a single line; take the first and trim a trailing newline.
    IFS= read -r branch < "$dir/snapshot-branch.ref" || true
    [[ -n "$branch" ]] || branch="(none)"
  fi

  printf 'prev-attempt: %s\n' "$attempt"
  printf 'prev-snapshot-branch: %s\n' "$branch"
  printf 'prev-failure-reason:\n'
  if [[ -s "$dir/failure.reason" ]]; then
    cat "$dir/failure.reason"
  else
    printf '(none recorded)\n'
  fi
  return 0
}
