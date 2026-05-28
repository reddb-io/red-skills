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
#     The kind of each registered command is taken from the
#     `HOOK_REGISTER_KIND` env var: `default` for built-in defaults, `user`
#     (the implicit default) for everything else. The kind is what gates
#     execution recording in `hook_dispatch` — only commands registered with
#     kind=user surface in `hook_executions_dump` and therefore in the
#     terminal Envelope's `data-section="hooks"` block (issue #215).
#
#   hook_canonical_names
#     Print the canonical lifecycle name set, one per line.
#
#   hook_executions_reset
#     Clear the recorded list of user-hook executions for the current
#     issue's lifecycle. Called by the orchestrator at the start of each
#     `process_issue` so the Envelope only carries hooks that ran during
#     this attempt. Truncates the file at `$HOOK_EXECUTIONS_FILE` when set
#     (the dispatcher writes there from every call, including the
#     `$(hook_dispatch …)` sites that run in a subshell and would
#     otherwise lose array appends), and clears the in-memory array used
#     by direct-call sites under unit tests.
#
#   hook_executions_dump FILE
#     Write the recorded user-hook executions to FILE in execution order,
#     one per line, in the deterministic shape
#     `<lifecycle_name> <command> exit=<code>`. Built-in defaults are
#     deliberately omitted — they are skill-owned and noisy, and the
#     Envelope block exists to surface *policy* the user wrote, not the
#     skill's own machinery. When `$HOOK_EXECUTIONS_FILE` is set, the
#     in-process file is the source of truth; otherwise the in-memory
#     array is used. Prints the number of lines written on stdout so the
#     caller can detect empty.

[[ "${_AFK_HOOK_DISPATCHER_LOADED:-}" == "1" ]] && return 0
_AFK_HOOK_DISPATCHER_LOADED=1

declare -gA HOOK_LISTS=()
declare -gA HOOK_KINDS=()
declare -ga HOOK_USER_EXECUTIONS=()
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
  # Kind is per-call (one HOOK_REGISTER_KIND env binding per `hook_register`
  # invocation), and every command in the trailing list inherits it. Only
  # `default` and `user` are accepted; anything else collapses to `user` so a
  # typo in a future default-registration site does not silently hide that
  # hook's executions from the Envelope.
  local kind="${HOOK_REGISTER_KIND:-user}"
  [[ "$kind" == "default" || "$kind" == "user" ]] || kind="user"
  local cmd
  for cmd in "$@"; do
    if [[ -n "${HOOK_LISTS[$name]:-}" ]]; then
      HOOK_LISTS[$name]="${HOOK_LISTS[$name]}"$'\n'"$cmd"
      HOOK_KINDS[$name]="${HOOK_KINDS[$name]}"$'\n'"$kind"
    else
      HOOK_LISTS[$name]="$cmd"
      HOOK_KINDS[$name]="$kind"
    fi
  done
}

hook_executions_reset() {
  HOOK_USER_EXECUTIONS=()
  if [[ -n "${HOOK_EXECUTIONS_FILE:-}" ]]; then
    : > "$HOOK_EXECUTIONS_FILE"
  fi
}

_hook_executions_record() {
  local name="$1" cmd="$2" rc="$3"
  HOOK_USER_EXECUTIONS+=("$name"$'\t'"$cmd"$'\t'"$rc")
  if [[ -n "${HOOK_EXECUTIONS_FILE:-}" ]]; then
    # Subshell-safe: a tab-separated triple per line, appended with `>>`
    # so concurrent dispatcher invocations from sibling subshells (the
    # orchestrator never runs hook_dispatch concurrently, but the contract
    # is safer this way) do not interleave inside a single line.
    printf '%s\t%s\t%s\n' "$name" "$cmd" "$rc" >> "$HOOK_EXECUTIONS_FILE"
  fi
}

hook_executions_dump() {
  local file="$1"
  : > "$file"
  local count=0
  if [[ -n "${HOOK_EXECUTIONS_FILE:-}" && -f "$HOOK_EXECUTIONS_FILE" ]]; then
    # File is the source of truth — it captures executions across the
    # `$(hook_dispatch …)` subshells that the in-memory array cannot see.
    local line _name _rest _cmd _rc
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      _name="${line%%$'\t'*}"
      _rest="${line#*$'\t'}"
      _cmd="${_rest%$'\t'*}"
      _rc="${_rest##*$'\t'}"
      printf '%s %s exit=%s\n' "$_name" "$_cmd" "$_rc" >> "$file"
      count=$((count + 1))
    done < "$HOOK_EXECUTIONS_FILE"
  else
    local entry _name _rest _cmd _rc
    for entry in "${HOOK_USER_EXECUTIONS[@]}"; do
      _name="${entry%%$'\t'*}"
      _rest="${entry#*$'\t'}"
      _cmd="${_rest%$'\t'*}"
      _rc="${_rest##*$'\t'}"
      printf '%s %s exit=%s\n' "$_name" "$_cmd" "$_rc" >> "$file"
      count=$((count + 1))
    done
  fi
  printf '%d\n' "$count"
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
  local kinds="${HOOK_KINDS[$name]:-}"

  if [[ -z "$list" ]]; then
    printf '%s' "$ctx"
    return 0
  fi

  # Snapshot kinds into a parallel array so we can read them in lockstep
  # with cmds. Recording goes through `_hook_executions_record`, which
  # writes to `$HOOK_EXECUTIONS_FILE` when set — that path is the source
  # of truth across the `$(hook_dispatch …)` sites the orchestrator uses
  # to capture mutated context (pre_session / pre_pick / pre_worktree /
  # pre_worker / post_pick), where the in-memory HOOK_USER_EXECUTIONS
  # array would be lost to subshell isolation. Direct-call sites populate
  # both the file and the array.
  local -a _kind_arr=()
  if [[ -n "$kinds" ]]; then
    while IFS= read -r _k; do
      _kind_arr+=("$_k")
    done <<< "$kinds"
  fi

  local cmd out rc i=0
  while IFS= read -r cmd; do
    if [[ -z "$cmd" ]]; then
      i=$((i + 1))
      continue
    fi
    local _kind="${_kind_arr[$i]:-user}"
    i=$((i + 1))
    rc=0
    out="$(printf '%s' "$ctx" | bash -c "$cmd" 2>&1)" || rc=$?
    # Record every user-declared hook execution, regardless of policy
    # outcome — the Envelope must show that a non-zero exit happened, not
    # hide it. Tab-separated triples; renderer in hook_executions_dump
    # formats them with the Envelope's documented shape.
    if [[ "$_kind" == "user" ]]; then
      _hook_executions_record "$name" "$cmd" "$rc"
    fi
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
