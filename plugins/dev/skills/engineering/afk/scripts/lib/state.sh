#!/usr/bin/env bash
# lib/state.sh — accessor module for .red/tmp/work-*/afk.state.json.
#
# Owns the v1 schema. Callers never write jq filters or touch the state file
# directly. Adding a new field is a one-line change to _STATE_JQ_FILTER below
# (plus an updated test fixture).
#
# Public surface:
#   state_read_into PREFIX path
#     Single jq invocation. Sets shell variables ${PREFIX}_<flat_key> for
#     every documented v1 field. Nested fields (current.X, filter.X,
#     envelope.X) flatten with an underscore. Missing fields receive their
#     documented default. Malformed JSON logs a warning and yields all
#     defaults — never aborts the caller.
#
#   state_write path field=value field2:=jsonvalue ...
#     Composes one jq filter setting each path; writes to path.tmp.$$ then
#     atomic mv. `key=value` treats value as a string; `key:=value` treats it
#     as a raw JSON literal (numbers, booleans, arrays, objects, null).
#     Dotted keys (e.g. current.stage) write into nested paths.
#
#   state_init path field=value ...
#     Resets path to a fresh v1 doc (version:=1, envelope:={posted:false}).
#     Any extra args are forwarded to state_write.
#
#   state_is_live path
#     Returns 0 if the pid recorded at .pid is still alive (kill -0), else 1.

# Schema-defaulting jq filter. Single invocation extracts every documented
# v1 field and emits `<flat_key>=<@sh-quoted-value>` lines.
_STATE_JQ_FILTER='
  . as $s
  | (($s // {}) | (.current // {})) as $c
  | (
      "version="                  + (($s.version            // 1)     | tostring | @sh),
      "worker_id="                + (($s.worker_id          // "")    | @sh),
      "pid="                      + (($s.pid                // 0)     | tostring | @sh),
      "log="                      + (($s.log                // "")    | @sh),
      "started_at="               + (($s.started_at         // "")    | @sh),
      "runner="                   + (($s.runner             // "")    | @sh),
      "total="                    + (($s.total              // 0)     | tostring | @sh),
      "done="                     + (($s.done               // 0)     | tostring | @sh),
      "failed="                   + (($s.failed             // 0)     | tostring | @sh),
      "blocked="                  + (($s.blocked            // 0)     | tostring | @sh),
      "completed="                + (($s.completed          // [])    | tojson    | @sh),
      "queue="                    + (($s.queue              // [])    | tojson    | @sh),
      "durations_seconds="        + (($s.durations_seconds  // [])    | tojson    | @sh),
      "envelope_posted="          + ((($s.envelope // {}).posted // false) | tostring | @sh),
      "filter_kind="              + ((($s.filter   // {}).kind   // "")    | @sh),
      "filter_value="             + ((($s.filter   // {}).value  // "")    | @sh),
      "current_number="           + (($c.number             // "")    | tostring | @sh),
      "current_title="            + (($c.title              // "")    | @sh),
      "current_slug="             + (($c.slug               // "")    | @sh),
      "current_worktree="         + (($c.worktree           // "")    | @sh),
      "current_handoff="          + (($c.handoff            // "")    | @sh),
      "current_started_at="       + (($c.started_at         // "")    | @sh),
      "current_stage="            + (($c.stage              // "")    | @sh),
      "current_heartbeat_glyph="  + (($c.heartbeat_glyph    // "")    | tostring | @sh),
      "current_heartbeat_pid="    + (($c.heartbeat_pid      // "")    | tostring | @sh),
      "current_runner="           + (($c.runner             // "")    | @sh),
      "current_retries="          + (($c.retries            // 0)     | tostring | @sh),
      "current_diff_added="       + (($c.diff_added         // 0)     | tostring | @sh),
      "current_diff_removed="     + (($c.diff_removed       // 0)     | tostring | @sh),
      "current_last_stream_line=" + (($c.last_stream_line   // "")    | @sh),
      "current_run_mode="         + (($c.run_mode           // "")    | @sh)
    )
'

# Emits the documented defaults by running the read filter on `{}`.
# Source of truth lives in _STATE_JQ_FILTER (single place to add fields).
_state_emit_defaults() { echo '{}' | jq -r "$_STATE_JQ_FILTER"; }

state_read_into() {
  local _prefix="$1" _path="$2"
  if [[ -z "$_prefix" ]]; then
    printf '[state] state_read_into: missing prefix\n' >&2
    return 2
  fi
  local _lines
  if [[ ! -f "$_path" ]]; then
    _lines="$(_state_emit_defaults)"
  elif ! _lines="$(jq -r "$_STATE_JQ_FILTER" "$_path" 2>/dev/null)"; then
    printf '[state] warning: malformed state file at %s — falling back to defaults\n' "$_path" >&2
    _lines="$(_state_emit_defaults)"
  fi
  local _line
  while IFS= read -r _line; do
    [[ -z "$_line" ]] && continue
    eval "${_prefix}_${_line}"
  done <<< "$_lines"
}

state_write() {
  local _path="$1"; shift
  [[ -z "$_path" ]] && return 0
  [[ $# -eq 0 ]] && return 0
  local _jq_args=() _filter="."
  local _i=0 _arg _key _value
  for _arg in "$@"; do
    if [[ "$_arg" == *":="* ]]; then
      _key="${_arg%%:=*}"
      _value="${_arg#*:=}"
      _jq_args+=(--argjson "v$_i" "$_value")
    elif [[ "$_arg" == *"="* ]]; then
      _key="${_arg%%=*}"
      _value="${_arg#*=}"
      _jq_args+=(--arg "v$_i" "$_value")
    else
      printf '[state] state_write: bad arg %q (expected key=value or key:=json)\n' "$_arg" >&2
      return 2
    fi
    _filter+=" | .${_key} = \$v${_i}"
    _i=$((_i+1))
  done
  local _input='{}'
  if [[ -f "$_path" ]]; then
    if jq empty "$_path" 2>/dev/null; then
      _input="$(cat "$_path")"
    else
      printf '[state] warning: malformed state file at %s — rewriting from empty\n' "$_path" >&2
    fi
  fi
  local _tmp
  if ! _tmp="$(mktemp "${_path}.tmp.XXXXXX" 2>/dev/null)"; then
    printf '[state] state_write: mktemp failed for %s\n' "$_path" >&2
    return 1
  fi
  if ! printf '%s' "$_input" | jq -c "${_jq_args[@]}" "$_filter" > "$_tmp" 2>/dev/null; then
    rm -f "$_tmp"
    printf '[state] state_write: jq filter failed: %s\n' "$_filter" >&2
    return 1
  fi
  mv "$_tmp" "$_path"
}

state_init() {
  local _path="$1"; shift
  printf '{}' > "$_path"
  state_write "$_path" version:=1 envelope:='{"posted":false}' "$@"
}

state_is_live() {
  local _path="$1"
  [[ -f "$_path" ]] || return 1
  local _pid
  _pid="$(jq -r '.pid // empty' "$_path" 2>/dev/null)"
  [[ -n "$_pid" && "$_pid" != "null" && "$_pid" != "0" ]] || return 1
  kill -0 "$_pid" 2>/dev/null
}
