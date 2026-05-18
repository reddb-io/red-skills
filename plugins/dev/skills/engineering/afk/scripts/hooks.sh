#!/usr/bin/env bash
# hooks.sh — generic three-layer hook orchestrator for the afk skill.
#
# Public surface:
#   hooks_run HOOK_POINT
#     Execute the three-layer chain for HOOK_POINT:
#       1. shipped detectors  ($AFK_PLUGIN_DIR/detectors/*.sh)
#       2. project detectors  ($PROJECT_ROOT/.red/hooks/detectors/*.sh)
#       3. project main hook  ($PROJECT_ROOT/.red/hooks/<point>.sh)
#     Files within each layer run in alphabetical (C-locale) order.
#     Each invocation receives its own $AFK_HOOK_ENV_FILE; on a 0 exit
#     the file is sourced back into the caller's environment with
#     `set -a` so exports propagate. Temp files are always deleted.
#
#     Failure semantics:
#       pre-spawn / pre-iteration / pre-merge  → first non-zero aborts,
#         the orchestrator returns the script's rc.
#       post-exit / post-iteration / post-merge → non-zero is logged
#         to stderr and execution continues; rc=0.
#       Detector exit code 1 means "not applicable" — it never counts
#         as failure and never appears in HOOKS_APPLIED_DETECTORS.
#
#   HOOKS_APPLIED_DETECTORS
#     Array of detector basenames (without .sh) that exited 0 during
#     the most recent hooks_run call. Layer 1 then layer 2 order.
#
# Detector enablement:
#   A shipped detector named <X> is skipped when the value of
#   `afk.hooks.defaults.<X>` in .red/config.yaml is the literal string
#   "false". Unknown detector names default to enabled. Project
#   detectors are never gated by config.
#
# Idempotent source guard.

[[ "${_AFK_HOOKS_SH_LOADED:-}" == "1" ]] && return 0
_AFK_HOOKS_SH_LOADED=1

_HOOKS_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=./config.sh
source "$_HOOKS_SCRIPT_DIR/config.sh"

declare -ga HOOKS_APPLIED_DETECTORS=()

_HOOKS_PRE_POINTS=(pre-spawn pre-iteration pre-merge)
_HOOKS_POST_POINTS=(post-exit post-iteration post-merge)

_hooks_log() {
  printf '[afk:hooks] %s\n' "$*" >&2
}

_hooks_classify() {
  local p="$1" x
  for x in "${_HOOKS_PRE_POINTS[@]}";  do [[ "$x" == "$p" ]] && { echo pre;  return 0; }; done
  for x in "${_HOOKS_POST_POINTS[@]}"; do [[ "$x" == "$p" ]] && { echo post; return 0; }; done
  return 1
}

_hooks_detector_enabled() {
  local name="$1" val
  val="$(config_get "afk.hooks.defaults.$name" 2>/dev/null || true)"
  [[ "$val" == "false" ]] && return 1
  return 0
}

# Run a single hook script in a fresh subprocess with its own env-file.
# Stdout: nothing. Returns the script's exit code. On rc=0 the env-file
# is sourced into the caller's shell.
_hooks_invoke() {
  local path="$1"
  local envfile rc=0
  envfile="$(mktemp -t afk-hook-env.XXXXXX)"
  : > "$envfile"

  AFK_HOOK_ENV_FILE="$envfile" "$path" || rc=$?

  if [[ $rc -eq 0 && -s "$envfile" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$envfile"
    set +a
  fi
  rm -f "$envfile"
  return $rc
}

# Collect *.sh under DIR (non-recursive), C-locale sorted, into a named array.
# Args: array_name, dir
_hooks_collect() {
  local __name="$1" dir="$2"
  eval "$__name=()"
  [[ -d "$dir" ]] || return 0
  local -a found=()
  local f
  # C-locale glob is already lexicographic; force it for determinism.
  local saved="${LC_ALL:-}"
  LC_ALL=C
  shopt -s nullglob
  for f in "$dir"/*.sh; do
    [[ -f "$f" ]] && found+=("$f")
  done
  shopt -u nullglob
  if [[ -n "$saved" ]]; then LC_ALL="$saved"; else unset LC_ALL; fi
  eval "$__name=(\"\${found[@]}\")"
}

hooks_run() {
  local hook_point="${1:-}"
  HOOKS_APPLIED_DETECTORS=()

  local kind
  if ! kind="$(_hooks_classify "$hook_point")"; then
    _hooks_log "unknown hook point: $hook_point"
    return 2
  fi

  local plugin_dir="${AFK_PLUGIN_DIR:-${SKILL_DIR:-$(dirname "$_HOOKS_SCRIPT_DIR")}}"
  local proj="${PROJECT_ROOT:-$PWD}"

  local -a shipped proj_det
  _hooks_collect shipped  "$plugin_dir/detectors"
  _hooks_collect proj_det "$proj/.red/hooks/detectors"
  local main_hook="$proj/.red/hooks/${hook_point}.sh"

  local path name rc

  # Layer 1 — shipped detectors (subject to config gating).
  for path in "${shipped[@]}"; do
    name="$(basename "$path" .sh)"
    if ! _hooks_detector_enabled "$name"; then
      continue
    fi
    rc=0
    _hooks_invoke "$path" || rc=$?
    case $rc in
      0) HOOKS_APPLIED_DETECTORS+=("$name") ;;
      1) ;;  # not applicable
      *)
        if [[ "$kind" == "pre" ]]; then
          _hooks_log "shipped detector '$name' failed (rc=$rc) on $hook_point — aborting"
          return "$rc"
        fi
        _hooks_log "shipped detector '$name' failed (rc=$rc) on $hook_point — continuing"
        ;;
    esac
  done

  # Layer 2 — project detectors (no config gating).
  for path in "${proj_det[@]}"; do
    name="$(basename "$path" .sh)"
    rc=0
    _hooks_invoke "$path" || rc=$?
    case $rc in
      0) HOOKS_APPLIED_DETECTORS+=("$name") ;;
      1) ;;
      *)
        if [[ "$kind" == "pre" ]]; then
          _hooks_log "project detector '$name' failed (rc=$rc) on $hook_point — aborting"
          return "$rc"
        fi
        _hooks_log "project detector '$name' failed (rc=$rc) on $hook_point — continuing"
        ;;
    esac
  done

  # Layer 3 — project main hook (any non-zero is a failure, no N/A rule).
  if [[ -f "$main_hook" ]]; then
    rc=0
    _hooks_invoke "$main_hook" || rc=$?
    if [[ $rc -ne 0 ]]; then
      if [[ "$kind" == "pre" ]]; then
        _hooks_log "main hook '$hook_point' failed (rc=$rc) — aborting"
        return "$rc"
      fi
      _hooks_log "main hook '$hook_point' failed (rc=$rc) — continuing"
    fi
  fi

  return 0
}
