#!/usr/bin/env bash
# lib/history.sh — the History Module: owns the afk-history.jsonl ledger end to
# end, following the pure / explicit-args contract of lib/state.sh and
# lib/merge.sh.
#
# The ledger is an append-only JSONL throughput record — one line per terminal
# event (done|blocked|exhausted) — that survives reboots and worktree wipes.
# The orchestrator appends to it and trims it; the monitor reads it for the 48h
# sparkline. Both the flock-serialised write discipline and the JSONL field
# schema live here once, with two real consumers, so the read schema is never
# re-derived inline in the monitor.
#
# Reads no orchestrator globals. Every input is a parameter — including the
# ledger path — so the Module stays unit-testable by sourcing it directly. The
# `ts`/`epoch` timestamps are read from the system clock; that is the Module's
# only ambient input, mirroring lib/state.sh's use of mktemp.
#
# Public surface:
#   history_append <path> <event> [KEY=VALUE]...
#     Appends exactly one JSONL record to <path>, flock-serialised so concurrent
#     workers never interleave a line. <event> is the terminal event name
#     (done|blocked|exhausted). The variadic KEY=VALUE pairs (mirroring
#     state_write) carry the event-specific fields, all optional:
#       worker      worker id string                       (default "")
#       issue       issue number, emitted as a JSON number (default 0)
#       runner      runner name string                     (default "")
#       duration_s  seconds, emitted as a JSON number      (default 0)
#       merge_sha   merge sha string; omitted from the record when empty
#       reason      reason string;    omitted from the record when empty
#     ts (ISO-8601) and epoch (seconds) are stamped from the clock. The parent
#     directory of <path> is created if missing.
#
#   history_trim <path> [max_lines]
#     Caps <path> to its last [max_lines] (default HISTORY_MAX_LINES_DEFAULT),
#     flock-serialised. When a trim actually happens it echoes the cap count to
#     stdout so a caller can log it; otherwise prints nothing. Always returns 0.
#
#   history_read_done_buckets <path> <from_hour> [buckets]
#     Echoes [buckets] (default 48) space-separated integers, oldest→newest:
#     per-hour counts of `done` events, hour index taken as
#     (epoch/3600 | floor) - <from_hour>, keeping indices in [0, buckets). This
#     is the exact read the sparkline needs. Returns non-zero (and prints
#     nothing) when <path> is missing or jq fails, so the caller can render its
#     own "no data" / "parse error" state.

HISTORY_MAX_LINES_DEFAULT=10000

# The single JSONL schema definition. Fields are stamped here and nowhere else.
_HISTORY_APPEND_FILTER='
  {ts:$ts, epoch:$epoch, worker:$worker, issue:$issue, event:$event,
   duration_s:$duration_s, runner:$runner}
  + (if $merge_sha != "" then {merge_sha:$merge_sha} else {} end)
  + (if $reason    != "" then {reason:$reason}       else {} end)'

# history_append <path> <event> [KEY=VALUE]...
history_append() {
  local _path="$1" _event="$2"
  [[ -z "$_path" || -z "$_event" ]] && { printf '[history] history_append: need <path> <event>\n' >&2; return 2; }
  shift 2
  local worker="" issue=0 runner="" duration_s=0 merge_sha="" reason=""
  local arg key val
  for arg in "$@"; do
    key="${arg%%=*}"; val="${arg#*=}"
    case "$key" in
      worker)     worker="$val" ;;
      issue)      issue="$val" ;;
      runner)     runner="$val" ;;
      duration_s) duration_s="$val" ;;
      merge_sha)  merge_sha="$val" ;;
      reason)     reason="$val" ;;
      *) printf '[history] history_append: unknown arg %q\n' "$arg" >&2 ;;
    esac
  done
  [[ -z "$issue"      ]] && issue=0
  [[ -z "$duration_s" ]] && duration_s=0
  mkdir -p "$(dirname "$_path")"
  local line
  line="$(jq -cn \
    --arg ts "$(date -Iseconds)" \
    --argjson epoch "$(date +%s)" \
    --arg worker "$worker" \
    --argjson issue "$issue" \
    --arg event "$_event" \
    --argjson duration_s "$duration_s" \
    --arg runner "$runner" \
    --arg merge_sha "$merge_sha" \
    --arg reason "$reason" \
    "$_HISTORY_APPEND_FILTER")"
  ( flock 9; printf '%s\n' "$line" >&9 ) 9>>"$_path"
}

# history_trim <path> [max_lines]
history_trim() {
  local _path="$1" _max="${2:-$HISTORY_MAX_LINES_DEFAULT}"
  [[ -f "$_path" ]] || return 0
  local n; n="$(wc -l < "$_path" 2>/dev/null || echo 0)"
  (( n > _max )) || return 0
  local tmp; tmp="$(mktemp)"
  tail -n "$_max" "$_path" > "$tmp"
  ( flock 9; cat "$tmp" > "$_path" ) 9>>"$_path"
  rm -f "$tmp"
  printf '%s' "$_max"
}

# history_read_done_buckets <path> <from_hour> [buckets]
history_read_done_buckets() {
  local _path="$1" _from="$2" _buckets="${3:-48}"
  [[ -f "$_path" ]] || return 1
  jq -rs --argjson from "$_from" --argjson n "$_buckets" '
    map(select(.event == "done"))
    | map((.epoch / 3600 | floor) - $from)
    | map(select(. >= 0 and . < $n))
    | reduce .[] as $b ([range($n) | 0]; .[$b] += 1)
    | join(" ")
  ' "$_path" 2>/dev/null
}
