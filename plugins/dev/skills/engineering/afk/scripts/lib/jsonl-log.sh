#!/usr/bin/env bash
# lib/jsonl-log.sh — the JSONL Log Module: owns the AFK structured-log lane
# format end to end, following the pure / explicit-args contract of
# lib/history.sh, lib/state.sh, and lib/merge.sh.
#
# A "lane" is an append-only JSONL file: one structured record per line, each a
# uniform envelope so a rollup reader never has to special-case a line's shape.
# The envelope is defined exactly once, here, with this field order:
#
#   {ts, lvl, worker, issue, attempt, type, msg, …extra}
#
# `ts` (ISO-8601) is stamped from the clock — the Module's only ambient input,
# mirroring lib/history.sh's use of the system clock. Everything else is an
# explicit argument, so the whole surface is unit-testable by sourcing the file
# directly (scripts/tests/jsonl-log.test.sh) with no orchestrator globals.
#
# Two write disciplines, matching the two lane kinds the orchestrator runs:
#
#   * Per-attempt lanes have a single writer (one worker, one attempt), so a
#     plain `>>` append is sufficient and cheapest — `jsonl_log_append`.
#   * Shared cross-worker lanes have many concurrent writers, so every write is
#     flock-serialised exactly as the afk-history ledger is, guaranteeing no two
#     workers ever interleave a partial line — `jsonl_log_append_shared`.
#
# The agent lane is the per-attempt lane carrying the inner agent's own output.
# Its appender (`jsonl_log_append_agent`) enforces by contract that the lane
# carries only agent output and nothing synthetic: it stamps `type=agent` and
# rejects any attempt to write a synthetic (orchestrator-authored) record type.
#
# Malformed input never corrupts a lane. Missing required args return non-zero
# with no write; a `msg` carrying newlines, quotes, or JSON metacharacters is
# escaped by jq into a single valid line; non-numeric issue/attempt and ill-
# formed extra keys are rejected before the lane is touched.
#
# Public surface:
#   jsonl_log_append <path> <type> <msg> [KEY=VALUE]...
#     Plain (unlocked) append of one envelope line to <path>. For per-attempt
#     lanes (single writer). Recognised KEYs: lvl (default "info"), worker
#     (default ""), issue (JSON number, default 0), attempt (JSON number,
#     default 0). Any other KEY=VALUE is added to the envelope verbatim as a
#     string field (the "…extra" of the schema). The parent directory of <path>
#     is created if missing. Returns 0 on a written line; 2 when <path> or
#     <type> is empty; 3 when issue/attempt is non-numeric or an extra key is
#     malformed — in every non-zero case nothing is written.
#
#   jsonl_log_append_shared <path> <type> <msg> [KEY=VALUE]...
#     Identical envelope and validation to jsonl_log_append, but the write is
#     flock-serialised so concurrent cross-worker writers never interleave a
#     line. For shared lanes.
#
#   jsonl_log_append_agent <path> <msg> [KEY=VALUE]...
#     The agent-lane appender. Stamps `type=agent` and appends plainly (the
#     agent lane is per-attempt). Rejects — rc 3, no write — any KEY=VALUE that
#     sets `type` to anything other than `agent`, so a synthetic/orchestrator
#     record can never reach the agent lane. Other KEYs behave as in
#     jsonl_log_append.
#
#   jsonl_log_filter_worker <path> <worker>
#     Echo, in file order, every record line in <path> whose `.worker` equals
#     <worker>. Returns non-zero with no output when <path> is missing, so the
#     caller renders its own "no data" state; an empty match on an existing file
#     is rc 0 with no output.
#
#   jsonl_log_filter_type <path> <type>
#     As jsonl_log_filter_worker, but matching `.type`.

# Synthetic record types: orchestrator-authored kinds that must never appear on
# the agent lane (which carries inner-agent output only). The list mirrors the
# audit-noise the handoff builder already filters out of human threads.
_JSONL_LOG_SYNTHETIC_TYPES=" boot heartbeat promotion envelope audit stamp "

# _jsonl_log_is_int <token> — true iff a non-negative integer (no sign, allows 0).
_jsonl_log_is_int() {
  [[ "$1" =~ ^(0|[1-9][0-9]*)$ ]]
}

# _jsonl_log_valid_key <token> — true iff a usable JSON field name: non-empty,
# [A-Za-z0-9_], not a digit-leading token (keeps extras readable / jq-safe).
_jsonl_log_valid_key() {
  [[ "$1" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]
}

# _jsonl_log_build <type> <msg> [KEY=VALUE]... — echo one compact JSON envelope
# line to stdout, or return non-zero (no output) on malformed input. The single
# schema definition; both appenders compose through it.
_jsonl_log_build() {
  local type="$1" msg="$2"
  shift 2
  local lvl="info" worker="" issue=0 attempt=0
  local extras='{}'
  local arg key val
  for arg in "$@"; do
    [[ "$arg" == *=* ]] || { printf '[jsonl-log] malformed arg %q (need KEY=VALUE)\n' "$arg" >&2; return 3; }
    key="${arg%%=*}"; val="${arg#*=}"
    case "$key" in
      lvl)     lvl="$val" ;;
      worker)  worker="$val" ;;
      issue)   issue="$val" ;;
      attempt) attempt="$val" ;;
      type|msg|ts)
        printf '[jsonl-log] reserved key %q cannot be set via KEY=VALUE\n' "$key" >&2; return 3 ;;
      *)
        _jsonl_log_valid_key "$key" || { printf '[jsonl-log] invalid extra key %q\n' "$key" >&2; return 3; }
        extras="$(jq -c --arg k "$key" --arg v "$val" '. + {($k): $v}' <<<"$extras")" || return 3
        ;;
    esac
  done
  [[ -z "$issue"   ]] && issue=0
  [[ -z "$attempt" ]] && attempt=0
  _jsonl_log_is_int "$issue"   || { printf '[jsonl-log] non-numeric issue %q\n' "$issue" >&2; return 3; }
  _jsonl_log_is_int "$attempt" || { printf '[jsonl-log] non-numeric attempt %q\n' "$attempt" >&2; return 3; }
  jq -cn \
    --arg ts "$(date -Iseconds)" \
    --arg lvl "$lvl" \
    --arg worker "$worker" \
    --argjson issue "$issue" \
    --argjson attempt "$attempt" \
    --arg type "$type" \
    --arg msg "$msg" \
    --argjson extra "$extras" \
    '{ts:$ts, lvl:$lvl, worker:$worker, issue:$issue, attempt:$attempt, type:$type, msg:$msg} + $extra'
}

# jsonl_log_append <path> <type> <msg> [KEY=VALUE]...
jsonl_log_append() {
  local _path="$1" _type="${2-}"
  [[ -z "$_path" || -z "$_type" ]] && { printf '[jsonl-log] jsonl_log_append: need <path> <type> <msg>\n' >&2; return 2; }
  shift 2
  local _msg="${1-}"; [[ $# -ge 1 ]] && shift
  local line; line="$(_jsonl_log_build "$_type" "$_msg" "$@")" || return 3
  mkdir -p "$(dirname "$_path")"
  printf '%s\n' "$line" >> "$_path"
}

# jsonl_log_append_shared <path> <type> <msg> [KEY=VALUE]...
jsonl_log_append_shared() {
  local _path="$1" _type="${2-}"
  [[ -z "$_path" || -z "$_type" ]] && { printf '[jsonl-log] jsonl_log_append_shared: need <path> <type> <msg>\n' >&2; return 2; }
  shift 2
  local _msg="${1-}"; [[ $# -ge 1 ]] && shift
  local line; line="$(_jsonl_log_build "$_type" "$_msg" "$@")" || return 3
  mkdir -p "$(dirname "$_path")"
  ( flock 9; printf '%s\n' "$line" >&9 ) 9>>"$_path"
}

# jsonl_log_append_agent <path> <msg> [KEY=VALUE]...
jsonl_log_append_agent() {
  local _path="$1"
  [[ -z "$_path" ]] && { printf '[jsonl-log] jsonl_log_append_agent: need <path> <msg>\n' >&2; return 2; }
  shift
  local _msg="${1-}"; [[ $# -ge 1 ]] && shift
  # The agent lane owns its type. A synthetic (orchestrator) type, or any
  # explicit type other than `agent`, is a contract violation — reject it.
  local arg key val
  for arg in "$@"; do
    [[ "$arg" == type=* ]] || continue
    val="${arg#type=}"
    if [[ "$val" != "agent" ]]; then
      printf '[jsonl-log] agent lane rejects type %q (lane carries agent output only)\n' "$val" >&2
      return 3
    fi
  done
  # Drop any redundant type=agent so _jsonl_log_build's reserved-key guard does
  # not trip; we stamp type=agent ourselves.
  local -a rest=()
  for arg in "$@"; do
    [[ "$arg" == type=* ]] && continue
    rest+=( "$arg" )
  done
  local line; line="$(_jsonl_log_build "agent" "$_msg" "${rest[@]}")" || return 3
  mkdir -p "$(dirname "$_path")"
  printf '%s\n' "$line" >> "$_path"
}

# jsonl_log_filter_worker <path> <worker>
jsonl_log_filter_worker() {
  local _path="$1" _worker="$2"
  [[ -f "$_path" ]] || return 1
  jq -c --arg w "$_worker" 'select(.worker == $w)' "$_path"
}

# jsonl_log_filter_type <path> <type>
jsonl_log_filter_type() {
  local _path="$1" _type="$2"
  [[ -f "$_path" ]] || return 1
  jq -c --arg t "$_type" 'select(.type == $t)' "$_path"
}
