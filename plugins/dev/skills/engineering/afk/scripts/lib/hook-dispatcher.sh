#!/usr/bin/env bash
# hook-dispatcher.sh — AFK lifecycle hook dispatcher (PRD #207, issue #208).
#
# Public surface:
#   hook_dispatch NAME CONTEXT_JSON
#     Run every command registered for lifecycle point NAME in registration
#     order (built-in defaults first, then user-declared commands). Each
#     command receives:
#       - the documented RED_AFK_* env vars (vars unset when irrelevant —
#         never empty-string, so `[ -z "$VAR" ]` works);
#       - the current context JSON on stdin;
#       - returns either an empty stdout (context unchanged) or a JSON
#         object on stdout (full replacement of the mutable slice).
#     Exit-code policy is taken from HOOK_EXIT_POLICY[NAME] — "abort" means
#     the first non-zero exit aborts the chain and propagates the rc;
#     "continue" means non-zero exits and parse failures are logged and
#     skipped. Non-JSON stdout is treated as a parse failure under both
#     policies (continue still skips, abort still aborts).
#
#     On success the final mutated context JSON is printed on stdout.
#
#   hook_register NAME COMMAND [COMMAND ...]
#     Append shell commands to the list for NAME. Used by both the config
#     loader (user hooks) and the built-in defaults registration block.
#
#   hook_canonical_names
#     Print the canonical lifecycle name set, one per line.

[[ "${_AFK_HOOK_DISPATCHER_LOADED:-}" == "1" ]] && return 0
_AFK_HOOK_DISPATCHER_LOADED=1

declare -gA HOOK_LISTS=()
declare -gA HOOK_EXIT_POLICY=(
  [pre_session]=abort
  [pre_pick]=abort
  [post_pick]=continue
  [pre_worktree]=abort
  [pre_worker]=abort
  [post_worker]=continue
  [pre_merge]=abort
  [post_merge]=continue
  [on_worker_error]=continue
  [on_idle]=continue
  [post_session]=continue
  [on_session_error]=continue
)

hook_canonical_names() {
  printf '%s\n' \
    pre_session pre_pick post_pick pre_worktree pre_worker post_worker \
    pre_merge post_merge on_worker_error on_idle post_session on_session_error
}

_hook_log() {
  printf '[afk:hooks] %s\n' "$*" >&2
}

hook_is_canonical() {
  local name="$1" n
  while IFS= read -r n; do
    [[ "$n" == "$name" ]] && return 0
  done < <(hook_canonical_names)
  return 1
}

hook_register() {
  local name="$1"; shift
  if ! hook_is_canonical "$name"; then
    _hook_log "refusing to register unknown hook '$name'"
    return 2
  fi
  local cmd
  for cmd in "$@"; do
    if [[ -n "${HOOK_LISTS[$name]:-}" ]]; then
      HOOK_LISTS[$name]="${HOOK_LISTS[$name]}"$'\n'"$cmd"
    else
      HOOK_LISTS[$name]="$cmd"
    fi
  done
}

_hook_is_json_object() {
  # Cheap structural check: starts with `{`, ends with `}`, parses with jq.
  local s="$1" trimmed
  trimmed="${s#"${s%%[![:space:]]*}"}"
  trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
  [[ -z "$trimmed" ]] && return 1
  [[ "${trimmed:0:1}" == "{" ]] || return 1
  printf '%s' "$trimmed" | jq -e 'type == "object"' >/dev/null 2>&1
}

hook_dispatch() {
  local name="$1"; shift || true
  local ctx="${1:-{\}}"

  if ! hook_is_canonical "$name"; then
    _hook_log "unknown lifecycle point '$name'"
    return 2
  fi

  local policy="${HOOK_EXIT_POLICY[$name]:-continue}"
  local list="${HOOK_LISTS[$name]:-}"

  if [[ -z "$list" ]]; then
    printf '%s' "$ctx"
    return 0
  fi

  local cmd out rc
  while IFS= read -r cmd; do
    [[ -z "$cmd" ]] && continue
    rc=0
    out="$(printf '%s' "$ctx" | bash -c "$cmd" 2>&1)" || rc=$?
    if (( rc != 0 )); then
      if [[ "$policy" == "abort" ]]; then
        _hook_log "$name: command failed (rc=$rc): $cmd"
        [[ -n "$out" ]] && printf '[afk:hooks] %s\n' "$out" >&2
        return "$rc"
      fi
      _hook_log "$name: command failed (rc=$rc), continuing: $cmd"
      [[ -n "$out" ]] && printf '[afk:hooks] %s\n' "$out" >&2
      continue
    fi
    # rc=0 path: empty stdout → no mutation; JSON object → replace context.
    local trimmed="${out#"${out%%[![:space:]]*}"}"
    trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
    if [[ -z "$trimmed" ]]; then
      continue
    fi
    if _hook_is_json_object "$trimmed"; then
      ctx="$trimmed"
      continue
    fi
    # rc=0 but non-JSON stdout → parse failure
    if [[ "$policy" == "abort" ]]; then
      _hook_log "$name: non-JSON stdout (parse failure) from: $cmd"
      printf '[afk:hooks] %s\n' "$out" >&2
      return 65
    fi
    _hook_log "$name: non-JSON stdout, ignoring (parse failure): $cmd"
  done <<< "$list"

  printf '%s' "$ctx"
  return 0
}
