#!/usr/bin/env bash
# /afk supervisor — maintains N concurrent /afk workers on a single checkout.
#
# Usage:
#   RED_AFK_TARGET=2 bash supervisor.sh [--request TEXT] [project_root]
#
# Env:
#   RED_AFK_TARGET  — desired worker count (default 2)
#   RED_AFK_REQUEST — optional special user request forwarded to every worker
#
# Worker env passthrough: any other RED_AFK_* var exported in the supervisor's
# shell is forwarded to every worker via `nohup env KEY=value …`. Use this to
# inject worker-side toggles like `RED_AFK_SKIP_PERF=1` or
# `RED_AFK_SKIP_COMPETITIVE_BASELINE=1` without writing a hook. Internal
# supervisor knobs (TARGET, POLL_S, STALL_*, CIRCUIT_*) and the per-slot
# `*_BASE` build-isolation vars are excluded — see PASSTHROUGH_DENYLIST.
#
# State (all under $PROJECT_ROOT/.red/tmp/, gitignored):
#   afk-supervisor.pid           — supervisor PID (single-supervisor lock)
#   afk-supervisor.log           — supervisor event log
#   afk-supervisor.stop          — touch to request graceful shutdown
#   afk-supervisor-slot-N.log    — per-slot worker stdout/stderr
#   afk-supervisor-circuit.json  — parked-slot circuit state (see below)
#
# Circuit breaker: each slot tracks fast deaths (worker exit within
# < FAST_DEATH_THRESHOLD_S seconds of spawn). Hitting CIRCUIT_K such
# deaths inside a CIRCUIT_WINDOW_S window parks the slot — no more
# respawns until the supervisor is restarted. Other slots keep going.
#
# Passive stall detector: every RED_AFK_STALL_POLL_S seconds the supervisor
# inspects each live slot's per-iteration *agent lane* (agent.log.jsonl)
# mtime — the clean liveness signal that carries one record per inner-agent
# turn and nothing synthetic. The orchestrator's heartbeat writes afk.log and
# the firehose every minute, so those lanes never go silent while a worker is
# alive; keying liveness off them masked genuine stalls (#243). The agent lane
# is the one lane the heartbeat never touches. A slot whose worker has been
# alive ≥ RED_AFK_STALL_THRESHOLD_S *and* whose agent lane hasn't advanced in
# ≥ RED_AFK_STALL_THRESHOLD_S is flagged `stalled:true` in the state file.
# Monitor reads the same file and renders stalled slots distinctly. The flag
# clears automatically on the next sample once the lane advances.
#
# Hard stall reaper: once a slot has been continuously silent on the agent
# lane for ≥ RED_AFK_STALL_KILL_THRESHOLD_S (default 30 min, must be greater
# than RED_AFK_STALL_THRESHOLD_S), the supervisor *considers* escalating — but
# silence alone is not death. The kill is gated behind the reaper-signal
# predicate (lib/reaper-signal.sh): a worker silent on the agent lane while a
# build/test descendant (vitest, tsc, cargo, …) is still running, or whose
# process tree shows non-trivial cpu, is BUSY and left alone. Only a worker
# that is idle past the threshold AND has no active descendant AND shows flat
# cpu is reaped: kill_tree the orchestrator process, post a
# `data-attempt-status="no-sentinel"` envelope referencing the iter dir's
# afk.log tail, restore the issue label to `ready-for-agent`, tear down the
# worktree + iter dir, and let the normal health-check loop respawn the slot.
# Conservative default leaves legitimate long iterations alone; operators can
# tune lower for noisy fleets or higher for compile-heavy projects. Idempotent
# per slot lifetime via SLOT_REAPED.
#
# Per-slot build isolation: build tools that serialize on a single cache
# directory (cargo, Gradle, …) can stall the fleet. When the operator sets
# a recognised `*_BASE` env var, the supervisor creates and exports a
# slot-specific subdirectory (`${BASE}/slot-{i}`) for each worker so each
# slot compiles in its own cache. Nothing is created or exported when the
# base var is unset — non-Rust / non-Gradle projects pay zero cost.
#
# Supported per-slot build env vars (see BUILD_ISOLATION_VARS below):
#   RED_AFK_CARGO_TARGET_BASE      → exports CARGO_TARGET_DIR=${BASE}/slot-{i}
#   RED_AFK_GRADLE_USER_HOME_BASE  → exports GRADLE_USER_HOME=${BASE}/slot-{i}
# Adding a new tool is a one-line append to BUILD_ISOLATION_VARS.
#
# The supervisor only manages worker process lifecycle. Workers are normal
# `afk.sh` invocations and own all claim-lock / state / queue semantics.

set -eo pipefail

# ---------- discovery ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(dirname "$SCRIPT_DIR")"
AFK_SH="$SCRIPT_DIR/afk.sh"
[[ -x "$AFK_SH" ]] || { echo "[supervisor] ERROR: afk.sh not found or not executable at $AFK_SH" >&2; exit 2; }

# shellcheck source=./config.sh
source "$SCRIPT_DIR/config.sh"
# shellcheck source=./hooks.sh
source "$SCRIPT_DIR/hooks.sh"
# shellcheck source=./lib/envelope.sh
source "$SCRIPT_DIR/lib/envelope.sh"
# shellcheck source=./lib/reaper-signal.sh
source "$SCRIPT_DIR/lib/reaper-signal.sh"

SUPERVISOR_REQUEST="${RED_AFK_REQUEST:-}"
PROJECT_ROOT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --request|-r) SUPERVISOR_REQUEST="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,11p' "$0"
      exit 0
      ;;
    *) PROJECT_ROOT="$1"; shift ;;
  esac
done

PROJECT_ROOT="${PROJECT_ROOT:-$(pwd)}"
PROJECT_ROOT="$(cd "$PROJECT_ROOT" && pwd)"
TMP_DIR="$PROJECT_ROOT/.red/tmp"
mkdir -p "$TMP_DIR"

PID_FILE="$TMP_DIR/afk-supervisor.pid"
LOG_FILE="$TMP_DIR/afk-supervisor.log"
STOP_FILE="$TMP_DIR/afk-supervisor.stop"
CIRCUIT_FILE="$TMP_DIR/afk-supervisor-circuit.json"
# Most-recent applied-detector list, one space-separated line. Written by
# `log_applied_detectors_boot_line` at boot and refreshed by each spawn;
# read by monitor.sh to render the `defaults:` field in the fleet header.
DEFAULTS_FILE="$TMP_DIR/afk-supervisor-defaults.txt"

RED_AFK_TARGET="${RED_AFK_TARGET:-2}"
STAGGER_S="${RED_AFK_STAGGER_S:-2}"
POLL_S="${RED_AFK_POLL_S:-15}"

# Circuit breaker tunables (overridable for tests).
FAST_DEATH_THRESHOLD_S="${RED_AFK_FAST_DEATH_S:-30}"
CIRCUIT_K="${RED_AFK_CIRCUIT_K:-5}"
CIRCUIT_WINDOW_S="${RED_AFK_CIRCUIT_WINDOW_S:-90}"

# Stall detector tunables. RED_AFK_STALL_THRESHOLD_S is the documented
# operator knob (default 10 min); RED_AFK_STALL_POLL_S is the supervisor's
# sampling cadence (default 30 s). A slot stays unflagged when alive
# for less than RED_AFK_STALL_THRESHOLD_S, even if it has produced no
# log output yet — that's normal startup, not a stall.
RED_AFK_STALL_THRESHOLD_S="${RED_AFK_STALL_THRESHOLD_S:-600}"
RED_AFK_STALL_POLL_S="${RED_AFK_STALL_POLL_S:-30}"

# Hard reap threshold — see header. Must be strictly greater than
# RED_AFK_STALL_THRESHOLD_S; validate_stall_thresholds enforces this at
# main-loop entry (sourcing supervisor.sh from tests deliberately skips
# the check so callers can stage arbitrary values).
RED_AFK_STALL_KILL_THRESHOLD_S="${RED_AFK_STALL_KILL_THRESHOLD_S:-1800}"

validate_stall_thresholds() {
  if (( RED_AFK_STALL_KILL_THRESHOLD_S <= RED_AFK_STALL_THRESHOLD_S )); then
    echo "[supervisor] ERROR: RED_AFK_STALL_KILL_THRESHOLD_S ($RED_AFK_STALL_KILL_THRESHOLD_S) must be > RED_AFK_STALL_THRESHOLD_S ($RED_AFK_STALL_THRESHOLD_S)" >&2
    return 2
  fi
  return 0
}

# Per-slot build-isolation env vars. Each entry is "BASE_VAR:TARGET_VAR".
# When BASE_VAR is set in the supervisor's env, every spawned worker on
# slot i gets TARGET_VAR=${BASE_VAR}/slot-{i} exported and the directory
# is `mkdir -p`'d before spawn. When BASE_VAR is unset, nothing happens
# for that pair — projects that don't compile with the tool see no side
# effects on their filesystem. Append a new line to support a new tool.
BUILD_ISOLATION_VARS=(
  "RED_AFK_CARGO_TARGET_BASE:CARGO_TARGET_DIR"
  "RED_AFK_GRADLE_USER_HOME_BASE:GRADLE_USER_HOME"
)

# ---------- logging ----------
log() {
  local ts msg
  ts="$(date -Iseconds)"
  msg="[$ts] [supervisor] $*"
  printf '%s\n' "$msg" >&2
  printf '%s\n' "$msg" >>"$LOG_FILE"
}

# ---------- single-supervisor lock ----------
acquire_lock() {
  if [[ -f "$PID_FILE" ]]; then
    local existing
    existing="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "$existing" ]] && kill -0 "$existing" 2>/dev/null; then
      echo "[supervisor] ERROR: another supervisor is alive (pid $existing); refusing to start" >&2
      exit 1
    fi
    log "clearing stale PID file (pid=${existing:-empty} not running)"
    rm -f "$PID_FILE"
  fi
  echo "$$" > "$PID_FILE"
  # Clear stale circuit state from a previous (crashed) supervisor. Restart
  # is the unparking mechanism — see acceptance criteria for #12.
  rm -f "$CIRCUIT_FILE"
  log "acquired lock (pid=$$, target=$RED_AFK_TARGET, project=$PROJECT_ROOT)"
}

# ---------- worker management ----------
declare -a SLOT_PIDS=()
declare -a SLOT_SPAWN_EPOCH=()
declare -a SLOT_FAST_DEATHS=()       # space-separated death epochs, pruned to window
declare -a SLOT_PARKED=()
declare -a SLOT_TRIP_EPOCH=()
declare -a SLOT_LAST_DEATH_EPOCH=()
declare -a SLOT_SWEPT=()              # 1 when sweep_parked_slot has already fired
declare -a SLOT_STALLED=()             # 1 when currently flagged stalled
declare -a SLOT_STALL_SINCE_EPOCH=()   # epoch when the stall window opened
declare -a SLOT_STALL_LOG=()           # iteration log path observed at stall time
declare -a SLOT_REAPED=()              # 1 when reap_stalled_slot has already fired
declare -a SLOT_WORKER_IDS=()           # per-slot RED_AFK_WORKER_ID handed to pre-spawn hooks
declare -a SLOT_APPLIED_DETECTORS=()    # most-recent applied detectors per slot (space-separated)
LAST_STALL_POLL_EPOCH=0

# Default runner name carried in the discard envelope. Real /afk fleet
# launches inherit this from the operator's shell; tests override.
SUPERVISOR_RUNNER="${RED_AFK_RUNNER:-claude}"

# Build the per-slot env overrides (e.g. CARGO_TARGET_DIR) for slot $1 as
# `KEY=value` strings suitable for `env`. Creates each slot subdirectory
# lazily. Echoes one assignment per line; emits nothing when no base env
# var is set.
build_slot_env_overrides() {
  local slot="$1" entry base_name target_name base_val slot_dir
  for entry in "${BUILD_ISOLATION_VARS[@]}"; do
    base_name="${entry%%:*}"
    target_name="${entry##*:}"
    base_val="${!base_name:-}"
    [[ -z "$base_val" ]] && continue
    slot_dir="${base_val}/slot-${slot}"
    mkdir -p "$slot_dir"
    printf '%s=%s\n' "$target_name" "$slot_dir"
  done
}

# Internal supervisor-only env vars that must NOT pass through to workers.
# These either control the supervisor itself (target, poll, breaker) or are
# already wired through dedicated paths (request, runner, per-slot _BASE).
# Anything else prefixed `RED_AFK_` gets auto-forwarded so operators can
# `export RED_AFK_SKIP_PERF=1` (etc) before launching `/dev:afk fleet` and
# have it reach every worker without writing a hook.
PASSTHROUGH_DENYLIST=(
  RED_AFK_TARGET
  RED_AFK_REQUEST
  RED_AFK_RUNNER
  RED_AFK_POLL_S
  RED_AFK_STALL_POLL_S
  RED_AFK_STALL_THRESHOLD_S
  RED_AFK_STALL_KILL_THRESHOLD_S
  RED_AFK_CIRCUIT_K
  RED_AFK_CIRCUIT_WINDOW_S
  RED_AFK_PLUGIN_DIR
  RED_AFK_SLOT
  RED_AFK_WORKER_ID
  RED_AFK_EXIT_CODE
  RED_AFK_DURATION_S
)

# build_passthrough_env — scan the supervisor's own environment for every
# `RED_AFK_*` variable that is *not* in PASSTHROUGH_DENYLIST and not a
# `_BASE` build-isolation var (those are handled by build_slot_env_overrides
# per slot). Emit one `KEY=value` line per match. Empty output when nothing
# matches. Order is deterministic (sorted by key).
build_passthrough_env() {
  local key val
  local -a deny=("${PASSTHROUGH_DENYLIST[@]}")
  # Compgen against env yields exported names; iterate sorted for stability.
  while IFS= read -r key; do
    [[ -z "$key" ]] && continue
    [[ "$key" == *_BASE ]] && continue
    local skip=0
    for d in "${deny[@]}"; do
      [[ "$key" == "$d" ]] && { skip=1; break; }
    done
    (( skip )) && continue
    val="${!key-}"
    [[ -z "${val+x}" ]] && continue
    printf '%s=%s\n' "$key" "$val"
  done < <(compgen -e | grep '^RED_AFK_' | sort)
}

# gen_supervisor_wid — fresh `wXXXX` worker ID handed to pre-spawn hooks via
# RED_AFK_WORKER_ID. Distinct from the runtime WORKER_ID afk.sh picks for itself —
# this one only labels the spawn for detector / post-exit hook bookkeeping.
gen_supervisor_wid() {
  local alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
  local id="" i idx
  for ((i=0; i<4; i++)); do
    idx=$(( RANDOM % ${#alphabet} ))
    id+="${alphabet:$idx:1}"
  done
  printf 'w%s' "$id"
}

# write_defaults_file — atomically record the most-recent applied detector
# list. Read by monitor.sh's render_fleet_header for the `defaults:` field.
write_defaults_file() {
  local applied="${1:-}"
  local tmp="$DEFAULTS_FILE.tmp.$$"
  printf '%s\n' "$applied" > "$tmp" && mv -f "$tmp" "$DEFAULTS_FILE"
}

# run_pre_spawn_hooks — fire the orchestrator's pre-spawn chain inside a
# subshell, capturing (a) the applied detector basenames and (b) every env
# var the detectors exported (computed as the diff between the subshell's
# env after our own AFK_* exports and the env after hooks_run returns).
#
# Side-effects in the supervisor's own environment are intentionally zero:
# detector exports stay scoped to the subshell, the caller reads back two
# small files in $OUTDIR, and the supervisor re-applies that env to the
# worker via `env KEY=value ...`.
#
# Args: slot, worker_id
# Echo: $OUTDIR (a freshly-created mktemp directory) — caller is
#       responsible for `rm -rf` after consuming `applied` + `env`.
# Returns: hook chain rc (0 on success; non-zero aborts the spawn).
run_pre_spawn_hooks() {
  local slot="$1" worker_id="$2"
  local outdir
  outdir="$(mktemp -d -t afk-prespawn.XXXXXX)"
  local rc=0
  (
    set +e
    export RED_AFK_SLOT="$slot"
    export RED_AFK_WORKER_ID="$worker_id"
    export RED_AFK_RUNNER="$SUPERVISOR_RUNNER"
    export RED_AFK_PLUGIN_DIR="$PLUGIN_DIR"
    export PROJECT_ROOT="$PROJECT_ROOT"
    env > "$outdir/baseline"
    # shellcheck disable=SC1090
    source "$SCRIPT_DIR/hooks.sh"
    hooks_run pre-spawn
    hrc=$?
    if (( hrc != 0 )); then exit "$hrc"; fi
    printf '%s\n' "${HOOKS_APPLIED_DETECTORS[*]}" > "$outdir/applied"
    env > "$outdir/after"
    comm -13 <(sort "$outdir/baseline") <(sort "$outdir/after") > "$outdir/env"
    exit 0
  )
  rc=$?
  rm -f "$outdir/baseline" "$outdir/after"
  printf '%s' "$outdir"
  return $rc
}

# run_post_exit_hooks — best-effort post-exit chain. Failures are logged
# but never delay the respawn (post-* points have continue-on-error
# semantics per hooks.sh).
run_post_exit_hooks() {
  local slot="$1" worker_id="$2" exit_code="$3" duration_s="$4"
  local rc=0
  (
    set +e
    export RED_AFK_SLOT="$slot"
    export RED_AFK_WORKER_ID="$worker_id"
    export RED_AFK_RUNNER="$SUPERVISOR_RUNNER"
    export RED_AFK_PLUGIN_DIR="$PLUGIN_DIR"
    export RED_AFK_EXIT_CODE="$exit_code"
    export RED_AFK_DURATION_S="$duration_s"
    export PROJECT_ROOT="$PROJECT_ROOT"
    # shellcheck disable=SC1090
    source "$SCRIPT_DIR/hooks.sh"
    hooks_run post-exit
  ) >/dev/null 2>&1
  rc=$?
  if (( rc != 0 )); then
    log "slot $slot: post-exit hook returned non-zero (rc=$rc) — continuing"
  fi
  return 0
}

spawn_slot() {
  local slot="$1"
  local slot_log="$TMP_DIR/afk-supervisor-slot-${slot}.log"
  local worker_id; worker_id="$(gen_supervisor_wid)"
  local outdir rc=0
  outdir="$(run_pre_spawn_hooks "$slot" "$worker_id")" || rc=$?
  if (( rc != 0 )); then
    log "slot $slot: pre-spawn hook failed (rc=$rc) wid=$worker_id — aborting spawn"
    [[ -d "$outdir" ]] && rm -rf "$outdir"
    return $rc
  fi
  local applied=""
  if [[ -f "$outdir/applied" ]]; then
    applied="$(<"$outdir/applied")"
    applied="${applied%$'\n'}"
  fi
  local -a env_args=()
  local line
  if [[ -f "$outdir/env" ]]; then
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      env_args+=("$line")
    done < "$outdir/env"
  fi
  rm -rf "$outdir"
  # Legacy operator-set BUILD_ISOLATION_VARS (RED_AFK_CARGO_TARGET_BASE,
  # RED_AFK_GRADLE_USER_HOME_BASE) win over detector defaults — they're appended
  # last so `env` resolves them last.
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    env_args+=("$line")
  done < <(build_slot_env_overrides "$slot")
  # Operator-set RED_AFK_* passthrough (RED_AFK_SKIP_PERF, RED_AFK_SKIP_*, etc).
  # Appended after build-isolation so explicit per-slot vars still win.
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    env_args+=("$line")
  done < <(build_passthrough_env)

  local -a worker_cmd=("$AFK_SH")
  if [[ -n "$SUPERVISOR_REQUEST" ]]; then
    worker_cmd+=(--request "$SUPERVISOR_REQUEST")
  fi
  worker_cmd+=("$PROJECT_ROOT")

  nohup env "${env_args[@]}" "${worker_cmd[@]}" >>"$slot_log" 2>&1 </dev/null &
  local pid=$!
  SLOT_PIDS[$slot]=$pid
  SLOT_SPAWN_EPOCH[$slot]="$(date +%s)"
  SLOT_WORKER_IDS[$slot]="$worker_id"
  SLOT_APPLIED_DETECTORS[$slot]="$applied"
  write_defaults_file "$applied"
  if (( ${#env_args[@]} > 0 )); then
    log "slot $slot: spawned worker pid=$pid wid=$worker_id (log=$slot_log, env=${env_args[*]})"
  else
    log "slot $slot: spawned worker pid=$pid wid=$worker_id (log=$slot_log)"
  fi
  if [[ -n "$applied" ]]; then
    log "slot $slot: pre-spawn: applied detectors [${applied// /, }]"
  else
    log "slot $slot: pre-spawn: applied detectors []"
  fi
}

# Write the supervisor state file (parked slots + stalled slots).
# Schema is additive on top of #12: `parked[]` keeps its original shape
# and `stalled[]` is appended. Readers that only consume `.parked[]?`
# (older monitor builds) keep working unchanged.
write_supervisor_state() {
  local parked=() stalled=() i trip last count trip_iso last_iso
  local since dur now log since_iso
  now="$(date +%s)"
  for ((i=0; i<RED_AFK_TARGET; i++)); do
    if [[ "${SLOT_PARKED[$i]:-0}" == "1" ]]; then
      trip="${SLOT_TRIP_EPOCH[$i]:-0}"
      last="${SLOT_LAST_DEATH_EPOCH[$i]:-0}"
      count="$(echo "${SLOT_FAST_DEATHS[$i]:-}" | wc -w | tr -d ' ')"
      trip_iso="$(date -Iseconds -d "@$trip" 2>/dev/null || echo "")"
      last_iso="$(date -Iseconds -d "@$last" 2>/dev/null || echo "")"
      parked+=("{\"slot\":$i,\"trip_at_epoch\":$trip,\"trip_at\":\"$trip_iso\",\"last_death_at_epoch\":$last,\"last_death_at\":\"$last_iso\",\"fast_deaths\":$count}")
    fi
    if [[ "${SLOT_STALLED[$i]:-0}" == "1" ]]; then
      since="${SLOT_STALL_SINCE_EPOCH[$i]:-0}"
      log="${SLOT_STALL_LOG[$i]:-}"
      dur=$(( now - since ))
      since_iso="$(date -Iseconds -d "@$since" 2>/dev/null || echo "")"
      stalled+=("{\"slot\":$i,\"since_epoch\":$since,\"since\":\"$since_iso\",\"duration_s\":$dur,\"log_path\":\"$log\"}")
    fi
  done
  local p_joined s_joined
  p_joined="$(IFS=,; echo "${parked[*]}")"
  s_joined="$(IFS=,; echo "${stalled[*]}")"
  printf '{"parked":[%s],"stalled":[%s]}\n' "$p_joined" "$s_joined" > "$CIRCUIT_FILE"
}

# Back-compat alias — handle_dead_slot below still uses the old name.
write_circuit_state() { write_supervisor_state; }

# Locate the per-iteration afk.log path for a slot's current worker
# process (find_slot_iter_dir owns the pid→dir lookup). Echoes the
# absolute log path on success and nothing when the worker is between
# iterations (legitimately silent). afk.log is the heartbeat-poisoned
# human log — the stall detector keys off the clean agent lane below
# (find_slot_agent_lane); this finder is kept for callers that want the
# back-compat plain log.
find_slot_iter_log() {
  local dir; dir="$(find_slot_iter_dir "$1")"
  [[ -n "$dir" ]] && printf '%s\n' "$dir/afk.log"
  return 0
}

# Locate the per-iteration clean agent lane (agent.log.jsonl) for a
# slot's current worker. This is the liveness signal the stall detector
# and hard-reaper watch: the orchestrator's heartbeat writes afk.log and
# the firehose every minute but never this lane, so its mtime advances
# only when the inner agent actually produces a turn (#243). Echoes the
# absolute path on success, nothing when the worker is between iterations.
find_slot_agent_lane() {
  local dir; dir="$(find_slot_iter_dir "$1")"
  [[ -n "$dir" ]] && printf '%s\n' "$dir/agent.log.jsonl"
  return 0
}

# Same shape as afk.sh's kill_tree — duplicated here so the supervisor
# does not have to source afk.sh (which has main-loop side effects).
# Recursively SIG to the pid and every descendant. Silent on missing
# pids — best-effort by design.
#
# Blast-radius guards (issue #193). The reaper feeds this function a PID
# read out of SLOT_PIDS[$slot], and recurses through `pgrep -P`. Every
# input is treated as untrusted: a corrupted bookkeeping entry, a stray
# negative PID, or `0` would otherwise turn a single `kill` into a
# pgroup-wide blast that takes the supervisor itself down (the
# orchestrator inherits the supervisor's pgrp because `nohup` does not
# `setsid`; `kill -SIG 0` targets the caller's pgrp). The guards refuse:
#
#   - empty / non-numeric pid (corrupted SLOT_PIDS, missing var)
#   - pid <= 1  (0 = caller's pgrp foot-gun; 1 = init)
#   - pid == SUPERVISOR_PID / $$ / BASHPID  (would trip the cleanup trap
#     and exit the supervisor cleanly — the exact symptom #193 reported)
#   - negative pid  (process-group target, never appropriate here)
#
# A refused recursion arg is silently skipped — best-effort still holds.
sup_kill_tree() {
  local pid="${1:-}" sig="${2:-TERM}"
  # Strip leading + and reject anything that is not a positive integer.
  case "$pid" in
    ''|*[!0-9]*) return 0 ;;
  esac
  (( pid > 1 )) || return 0
  (( pid == ${SUPERVISOR_PID:-$$} )) && return 0
  (( pid == BASHPID )) && return 0
  local k
  for k in $(pgrep -P "$pid" 2>/dev/null); do
    sup_kill_tree "$k" "$sig"
  done
  kill -"$sig" "$pid" 2>/dev/null || true
}

# Same matching logic as find_slot_iter_log but returns the iter
# directory itself. Echoes nothing when the worker is between
# iterations (no worker.pid match, or no attempt dir yet).
# Matches the slot's worker pid against the per-worker workers/{wid}/worker.pid
# (PRD #244 #252), then returns the worker's CURRENT iteration — its newest
# attempt dir under workers/{wid}/.
find_slot_iter_dir() {
  local slot="$1"
  local pid="${SLOT_PIDS[$slot]:-}"
  local pid_file wdir d newest
  [[ -n "$pid" ]] || return 0
  shopt -s nullglob
  for pid_file in "$TMP_DIR"/workers/*/worker.pid; do
    [[ -f "$pid_file" ]] || continue
    [[ "$(cat "$pid_file" 2>/dev/null)" == "$pid" ]] || continue
    wdir="$(dirname "$pid_file")"
    newest=""
    for d in "$wdir"/*/; do
      [[ -d "$d" ]] || continue
      if [[ -z "$newest" || "$d" -nt "$newest" ]]; then newest="${d%/}"; fi
    done
    [[ -n "$newest" ]] && printf '%s\n' "$newest"
    return 0
  done
}

# Pure predicate for unit testing. Given the worker's spawn epoch,
# the iteration log's last-modified epoch (0 = no log yet), the
# current epoch, and the stall threshold, echo `yes` when the slot
# meets every stall criterion and `no` otherwise.
compute_stalled() {
  local spawn="$1" log_mtime="$2" now="$3" threshold="$4"
  (( spawn > 0 )) || { echo no; return; }
  (( now - spawn >= threshold )) || { echo no; return; }
  # If we never observed a log (worker still between iterations or hasn't
  # opened one yet), don't flag — there's nothing to compare against.
  (( log_mtime > 0 )) || { echo no; return; }
  (( now - log_mtime >= threshold )) || { echo no; return; }
  echo yes
}

# Build/test executables whose presence under the worker tree means the worker
# is doing real work even while the agent lane is silent (#243). Many JS-
# ecosystem tools run as `node`, so this list is not exhaustive on its own —
# the cpu signal (sup_tree_cpu) catches the rest. Matched against `ps -o comm=`
# basenames, anchored and case-insensitive. Overridable for unusual toolchains.
REAPER_BUSY_CMD_RE="${RED_AFK_REAPER_BUSY_CMD_RE:-vitest|jest|mocha|playwright|tsc|tsx|esbuild|webpack|rollup|vite|cargo|rustc|gradle|mvn|javac|java|pytest|python[0-9.]*|go|make|cmake|ninja|cc1|cc1plus|gcc|g\+\+|clang|clang\+\+|ld|bun}"

# sup_descendant_pids <pid> — echo <pid> and every descendant pid, one per line.
# Guards mirror sup_kill_tree: a non-numeric or <=1 pid yields nothing.
sup_descendant_pids() {
  local pid="${1:-}" k
  case "$pid" in ''|*[!0-9]*) return 0 ;; esac
  (( pid > 1 )) || return 0
  printf '%s\n' "$pid"
  for k in $(pgrep -P "$pid" 2>/dev/null); do
    sup_descendant_pids "$k"
  done
}

# sup_active_descendant <pid> — `yes` when any process in the worker tree is a
# recognised build/test tool (REAPER_BUSY_CMD_RE), else `no`. Best-effort: a
# missing tree or a ps failure reads as `no`. Defined as a function so tests can
# stub it without a live process tree.
sup_active_descendant() {
  local pid="${1:-}" pids
  pids="$(sup_descendant_pids "$pid" | paste -sd, -)"
  [[ -n "$pids" ]] || { echo no; return; }
  if ps -o comm= -p "$pids" 2>/dev/null | grep -Eiq "^(${REAPER_BUSY_CMD_RE})$"; then
    echo yes
  else
    echo no
  fi
}

# sup_tree_cpu <pid> — aggregate %cpu across the worker tree (pid + all
# descendants), echoed as a one-decimal string (0.0 when the tree is gone).
# Best-effort; never aborts the caller. A function so tests can stub it.
sup_tree_cpu() {
  local pid="${1:-}" pids
  pids="$(sup_descendant_pids "$pid" | paste -sd, -)"
  [[ -n "$pids" ]] || { echo 0; return; }
  ps -o %cpu= -p "$pids" 2>/dev/null | awk '{s+=$1} END{printf "%.1f", s+0}'
}

# Sample every non-parked slot. Sets / clears SLOT_STALLED[slot] and
# rewrites the state file when any slot's stall flag flipped. Liveness is
# read from the clean agent lane (agent.log.jsonl), never afk.log/firehose —
# the heartbeat poisons those every minute (#243). The flag itself is passive
# bookkeeping; the only action taken is the gated hard reap below.
poll_stall_detector() {
  local now changed=0 i lane mtime spawn flagged
  now="$(date +%s)"
  for ((i=0; i<RED_AFK_TARGET; i++)); do
    [[ "${SLOT_PARKED[$i]:-0}" == "1" ]] && continue
    spawn="${SLOT_SPAWN_EPOCH[$i]:-0}"
    lane="$(find_slot_agent_lane "$i")"
    mtime=0
    if [[ -n "$lane" && -f "$lane" ]]; then
      mtime="$(stat -c %Y "$lane" 2>/dev/null || echo 0)"
    fi
    flagged="$(compute_stalled "$spawn" "$mtime" "$now" "$RED_AFK_STALL_THRESHOLD_S")"
    if [[ "$flagged" == "yes" ]]; then
      if [[ "${SLOT_STALLED[$i]:-0}" != "1" ]]; then
        SLOT_STALLED[$i]=1
        # Anchor the stall window to the last observed agent-lane activity so
        # the duration the monitor renders matches "agent lane idle for N".
        SLOT_STALL_SINCE_EPOCH[$i]="$mtime"
        SLOT_STALL_LOG[$i]="$lane"
        log "⏸️  slot $i flagged stalled (agent lane idle for $(( now - mtime ))s: $lane)"
        changed=1
      fi
      # Hard-reap escalation: silence past RED_AFK_STALL_KILL_THRESHOLD_S makes
      # the slot a *candidate*, but agent-lane silence alone is not death (#243).
      # Sample the worker tree and gate the irreversible kill behind the
      # reaper-signal predicate — a worker mid-build/test (active descendant) or
      # burning cpu is busy, never reaped. Reclaimed once per slot lifetime.
      local since="${SLOT_STALL_SINCE_EPOCH[$i]:-0}"
      if (( since > 0 )) \
         && (( now - since >= RED_AFK_STALL_KILL_THRESHOLD_S )) \
         && [[ "${SLOT_REAPED[$i]:-0}" != "1" ]]; then
        local orch="${SLOT_PIDS[$i]:-}" idle active cpu decision
        idle=$(( now - since ))
        active="$(sup_active_descendant "$orch")"
        cpu="$(sup_tree_cpu "$orch")"
        decision="$(reaper_signal_decide "$idle" "$RED_AFK_STALL_KILL_THRESHOLD_S" "$active" "$cpu")"
        if [[ "$decision" == "kill" ]]; then
          reap_stalled_slot "$i"
          changed=1
        else
          log "🛡️  slot $i silent ${idle}s but busy (active_descendant=$active cpu=${cpu}%) — deferring reap"
        fi
      fi
    else
      if [[ "${SLOT_STALLED[$i]:-0}" == "1" ]]; then
        SLOT_STALLED[$i]=0
        SLOT_STALL_SINCE_EPOCH[$i]=0
        SLOT_STALL_LOG[$i]=""
        log "▶️  slot $i stall cleared (agent lane advanced)"
        changed=1
      fi
    fi
  done
  (( changed )) && write_supervisor_state
  LAST_STALL_POLL_EPOCH="$now"
}

# ---------- circuit-trip sweep (issue #13) ----------
# When a slot trips the circuit breaker, the supervisor — not a human —
# cleans up after the burned workers. Three actions in order:
#
#   1. Sweep iter dirs whose worker IDs occupied the parked slot during
#      the fast-death window. State files identify the affected issues.
#   2. Post a `data-attempt-status="discarded"` envelope on each affected
#      issue naming the runner and the trip cause.
#   3. Swap `ready-for-human` (and any stale `running`) for
#      `ready-for-agent` and tag the issue `runner-error` so the human
#      can filter runner-broken issues out of the normal triage view.
#
# Idempotent within a supervisor lifetime via SLOT_SWEPT. Across
# restarts a new trip yields fresh worker IDs / fresh iter dirs, so
# re-tripping does not re-touch already-swept issues.

# parse_worker_ids_from_log <slot_log_path>
# Echo each unique worker ID (`wXXXX`) seen in the boot-stamp lines
# afk.sh emits at the top of every spawn. Order preserves first-seen.
# Pure function — only reads the given file path.
parse_worker_ids_from_log() {
  local path="$1"
  [[ -f "$path" ]] || return 0
  awk '
    /^\[afk\] worker: w[A-Z0-9]+$/ {
      wid = $3
      if (!seen[wid]++) print wid
    }
  ' "$path"
}

# iter_dir_for_worker <worker_id>
# Echo every `.red/tmp/workers/{wid}/{issue}-a{n}/` attempt directory that
# exists for the given worker ID. Multiple attempt dirs per worker are possible
# when the worker drained several issues (or retried) before its slot got parked.
iter_dirs_for_worker() {
  local wid="$1" d
  shopt -s nullglob
  for d in "$TMP_DIR"/workers/"${wid}"/*/; do
    [[ -d "$d" ]] && printf '%s\n' "${d%/}"
  done
  shopt -u nullglob
}

# iter_dir_issue_number <iter_dir>
# Read .current.number from afk.state.json. Echoes the issue number or
# nothing (worker died before claiming).
iter_dir_issue_number() {
  local d="$1" sf="$1/afk.state.json"
  [[ -f "$sf" ]] || return 0
  jq -r '.current.number // empty' "$sf" 2>/dev/null
}

# discard_summary_line <runner> <fast_deaths>
# The discarded Envelope's summary line. Distinct shape from the worker
# summary (runner + trip cause, no duration/diff/attempt).
discard_summary_line() {
  local runner="$1" deaths="$2"
  printf 'runner `%s` · status: discarded · cause: runner-broken, slot parked after %s fast deaths' \
    "$runner" "$deaths"
}

# discard_section_body <slot> <wids_csv> <fast_deaths> <log_path>
# Body of the discarded Envelope's `data-section="summary"` block. No trailing
# newline — envelope_build_body appends the section's blank-line padding.
discard_section_body() {
  local slot="$1" wids="$2" deaths="$3" log_path="$4"
  printf 'slot: %s\nworker IDs: %s\nfast deaths: %s\nsupervisor log: %s' \
    "$slot" "$wids" "$deaths" "$log_path"
}

# build_discard_envelope <runner> <slot> <wids_csv> <fast_deaths> <log_path>
# Emits the full envelope body for the structured comment. Composes through the
# Envelope Module's envelope_build_body — the single `data-attempt-status` +
# `data-section` schema definition — so the envelope parser handles it without
# a new branch and the discard variant cannot drift from the worker variant.
build_discard_envelope() {
  local runner="$1" slot="$2" wids="$3" deaths="$4" log_path="$5"
  local sumfile; sumfile="$(mktemp)"
  discard_section_body "$slot" "$wids" "$deaths" "$log_path" > "$sumfile"
  envelope_build_body "discarded" "$(discard_summary_line "$runner" "$deaths")" summary "$sumfile"
  rm -f "$sumfile"
}

# ensure_runner_error_label
# Idempotently create the `runner-error` label in the live repo. Silent
# success when the label already exists; loud warning when gh fails.
ensure_runner_error_label() {
  command -v gh >/dev/null 2>&1 || return 0
  gh label create runner-error \
    --color B60205 \
    --description "AFK supervisor circuit-tripped; runner was misconfigured" \
    >/dev/null 2>&1 || true
}

# sweep_parked_slot <slot>
# Drive the three-step cleanup. Tolerant of missing gh, missing jq,
# missing iter dirs — the supervisor must keep running other slots even
# if the cleanup partially fails.
sweep_parked_slot() {
  local slot="$1"
  [[ "${SLOT_SWEPT[$slot]:-0}" == "1" ]] && return 0
  SLOT_SWEPT[$slot]=1

  local slot_log="$TMP_DIR/afk-supervisor-slot-${slot}.log"
  local sup_log_rel=".red/tmp/afk-supervisor.log"
  local deaths; deaths="$(echo "${SLOT_FAST_DEATHS[$slot]:-}" | wc -w | tr -d ' ')"
  local wids=() w
  while IFS= read -r w; do
    [[ -n "$w" ]] && wids+=("$w")
  done < <(parse_worker_ids_from_log "$slot_log")

  if (( ${#wids[@]} == 0 )); then
    log "slot $slot sweep: no worker IDs observed in $slot_log — no iter dirs to sweep"
    return 0
  fi

  local wids_csv; wids_csv="$(IFS=,; echo "${wids[*]}")"
  log "slot $slot sweep: workers=${wids_csv}"

  # Collect (iter_dir, issue_number) pairs across all observed workers.
  local pairs=() dir issue
  for w in "${wids[@]}"; do
    while IFS= read -r dir; do
      [[ -z "$dir" ]] && continue
      issue="$(iter_dir_issue_number "$dir")"
      pairs+=("${dir}|${issue}")
    done < <(iter_dirs_for_worker "$w")
  done

  if (( ${#pairs[@]} == 0 )); then
    log "slot $slot sweep: no iter dirs found for workers ${wids_csv} (no-op sweep, slot stays parked)"
    return 0
  fi

  ensure_runner_error_label

  local repo=""
  if command -v gh >/dev/null 2>&1; then
    repo="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
  fi

  # Injected poster: routes the discard Envelope's post through the same
  # callback contract afk.sh uses. Captured `repo` keeps the Module gh-free.
  _sup_envelope_poster() {  # <issue> <body>
    gh -R "$repo" issue comment "$1" --body "$2" >/dev/null 2>&1
  }

  local pair affected_issues=() sumfile
  for pair in "${pairs[@]}"; do
    dir="${pair%%|*}"
    issue="${pair##*|}"
    if [[ -n "$issue" && "$issue" != "null" && -n "$repo" ]]; then
      # Post the discarded Envelope through the shared Module entry point —
      # the supervisor is the second adapter on envelope_emit_attempt.
      sumfile="$(mktemp)"
      discard_section_body "$slot" "$wids_csv" "$deaths" "$sup_log_rel" > "$sumfile"
      if envelope_emit_attempt \
           poster=_sup_envelope_poster status=discarded "issue=$issue" \
           "summary=$(discard_summary_line "$SUPERVISOR_RUNNER" "$deaths")" \
           "section_file=$sumfile"; then
        log "slot $slot sweep: posted discard envelope on #$issue"
      else
        log "slot $slot sweep: WARN failed to post envelope on #$issue"
      fi
      rm -f "$sumfile"
      gh -R "$repo" issue edit "$issue" \
        --add-label "ready-for-agent" \
        --add-label "runner-error" \
        --remove-label "ready-for-human" \
        --remove-label "running" \
        >/dev/null 2>&1 \
        && log "slot $slot sweep: restored labels on #$issue (+ready-for-agent +runner-error)" \
        || log "slot $slot sweep: WARN failed to edit labels on #$issue"
      affected_issues+=("$issue")
    fi
    if [[ -d "$dir" ]]; then
      rm -rf "$dir" \
        && log "slot $slot sweep: removed iter dir $dir" \
        || log "slot $slot sweep: WARN failed to rm $dir"
    fi
  done

  if (( ${#affected_issues[@]} == 0 )); then
    log "slot $slot sweep: iter dirs cleaned, no claimed issues to restore"
  fi
}

# reap_stalled_slot <slot>
# Hard-reap a slot whose worker has been silent past
# RED_AFK_STALL_KILL_THRESHOLD_S. Steps in order, every step best-effort
# past the kill so a partial cleanup never blocks the rest:
#   1. Kill the orchestrator tree (TERM, 5s grace, then KILL).
#   2. Free the slot bookkeeping so the next health-check respawns it.
#   3. If we recovered an issue number from afk.state.json: post a
#      `no-sentinel` envelope via the shared envelope_emit_attempt entry
#      point and rotate labels back to ready-for-agent.
#   4. Tear down worktree, branch, iter dir.
# Idempotent per supervisor lifetime via SLOT_REAPED; on restart the
# iter dir is gone so re-reap is a natural no-op.
reap_stalled_slot() {
  local slot="$1"
  [[ "${SLOT_REAPED[$slot]:-0}" == "1" ]] && return 0
  SLOT_REAPED[$slot]=1

  local now since elapsed
  now="$(date +%s)"
  since="${SLOT_STALL_SINCE_EPOCH[$slot]:-0}"
  elapsed=$(( now - since ))

  local orch_pid="${SLOT_PIDS[$slot]:-}"
  local iter_dir; iter_dir="$(find_slot_iter_dir "$slot")"

  local issue="" title="" slug="" worker_id="" started_at=""
  if [[ -n "$iter_dir" && -f "$iter_dir/afk.state.json" ]] \
     && command -v jq >/dev/null 2>&1; then
    local sf="$iter_dir/afk.state.json"
    issue="$(jq -r '.current.number // empty' "$sf" 2>/dev/null)"
    title="$(jq -r '.current.title // empty' "$sf" 2>/dev/null)"
    slug="$(jq -r '.current.slug // empty' "$sf" 2>/dev/null)"
    worker_id="$(jq -r '.worker_id // empty' "$sf" 2>/dev/null)"
    started_at="$(jq -r '.started_at // empty' "$sf" 2>/dev/null)"
  fi

  # 1. kill_tree the orchestrator.
  if [[ -n "$orch_pid" ]] && kill -0 "$orch_pid" 2>/dev/null; then
    sup_kill_tree "$orch_pid" TERM
    sleep 5
    if kill -0 "$orch_pid" 2>/dev/null; then
      sup_kill_tree "$orch_pid" KILL
    fi
  fi

  # 2. Free the slot — clear bookkeeping so the health-check respawn loop
  # picks it up on the next cycle even if cleanup below partially fails.
  SLOT_PIDS[$slot]=""
  SLOT_STALLED[$slot]=0
  SLOT_STALL_SINCE_EPOCH[$slot]=0
  SLOT_STALL_LOG[$slot]=""

  # 3. Post envelope + rotate labels (skip silently if we never learned the
  # issue number — the worker died before claim, the iter dir is enough).
  if [[ -n "$issue" && "$issue" != "null" ]] && command -v gh >/dev/null 2>&1; then
    local repo
    repo="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"

    local notes_tmp log_tmp
    notes_tmp="$(mktemp)"; log_tmp="$(mktemp)"
    if [[ -f "$iter_dir/handoff.md" ]]; then
      envelope_extract_notes "$iter_dir/handoff.md" > "$notes_tmp"
    fi
    [[ -s "$notes_tmp" ]] || printf '(no agent notes recorded before stall-reap)\n' > "$notes_tmp"
    if [[ -f "$iter_dir/afk.log" ]]; then
      tail -n 50 "$iter_dir/afk.log" > "$log_tmp"
    else
      : > "$log_tmp"
    fi

    local duration_s=0 started_epoch
    if [[ -n "$started_at" ]]; then
      started_epoch="$(date -d "$started_at" +%s 2>/dev/null || echo 0)"
      (( started_epoch > 0 )) && duration_s=$(( now - started_epoch ))
    fi
    local summary
    summary="$(printf 'worker `%s` · status: no-sentinel · duration: %s · diff: stall-reaped · attempt: 1 · reason: stall-reaped' \
      "${worker_id:-unknown}" "$(envelope_fmt_duration "$duration_s")")"

    local branch="afk/${worker_id}/${issue}-${slug}"
    local remote_name="afk-attempts/${worker_id}/${issue}-${slug}"
    local worktree_rel=".red/tmp/${iter_dir#"$TMP_DIR"/}/worktree"
    local repo_dir="$iter_dir/worktree"
    [[ -d "$repo_dir" ]] || repo_dir=""

    _sup_reaper_poster() { gh -R "$repo" issue comment "$1" --body "$2" >/dev/null 2>&1; }

    if [[ -n "$repo" ]]; then
      if envelope_emit_attempt \
           poster=_sup_reaper_poster status=no-sentinel "issue=$issue" \
           "summary=$summary" "repo=$repo" "repo_dir=$repo_dir" \
           "branch=$branch" "remote_name=$remote_name" \
           "worktree_rel=$worktree_rel" \
           "diffstat=(stall-reaped, no diff computed)" \
           "notes_file=$notes_tmp" "log_file=$log_tmp"; then
        log "slot $slot reap: posted no-sentinel envelope on #$issue"
      else
        log "slot $slot reap: WARN failed to post envelope on #$issue"
      fi
      if gh -R "$repo" issue edit "$issue" \
           --remove-label running \
           --add-label ready-for-agent \
           >/dev/null 2>&1; then
        log "slot $slot reap: restored labels on #$issue (+ready-for-agent -running)"
      else
        log "slot $slot reap: WARN failed to edit labels on #$issue"
      fi
    fi
    rm -f "$notes_tmp" "$log_tmp"
  fi

  # 4. Teardown — worktree + local branch + iter dir.
  if [[ -n "$iter_dir" && -d "$iter_dir/worktree" ]]; then
    git -C "$PROJECT_ROOT" worktree remove --force "$iter_dir/worktree" >/dev/null 2>&1 || true
  fi
  if [[ -n "$worker_id" && -n "$issue" && -n "$slug" ]]; then
    git -C "$PROJECT_ROOT" branch -D "afk/${worker_id}/${issue}-${slug}" >/dev/null 2>&1 || true
  fi
  if [[ -n "$iter_dir" && -d "$iter_dir" ]]; then
    rm -rf "$iter_dir" || true
  fi

  log "slot $slot: hard-reaped after stalled ${elapsed}s (orchestrator pid=${orch_pid:-?}, issue=#${issue:-?}, worker=${worker_id:-?})"
}

# Handle a slot whose worker has exited: decide park-or-respawn based on
# fast-death history. A "fast death" is a worker that exited within
# < FAST_DEATH_THRESHOLD_S of being spawned. Hitting CIRCUIT_K such deaths
# inside CIRCUIT_WINDOW_S parks the slot — log a loud line, record state,
# and stop spawning. Slow deaths reset nothing in particular: the death-time
# ring naturally prunes anything older than the window on each pass.
handle_dead_slot() {
  local slot="$1"
  local now spawn_at lifetime exit_code=0
  now="$(date +%s)"
  spawn_at="${SLOT_SPAWN_EPOCH[$slot]:-0}"
  lifetime=$(( now - spawn_at ))

  # Reap the worker zombie so we can pass a real exit code to post-exit.
  # `wait` only succeeds on a process that was backgrounded by this shell;
  # if it fails (already reaped, unknown pid, …) we keep the default 0.
  local pid="${SLOT_PIDS[$slot]:-}"
  if [[ -n "$pid" ]]; then
    wait "$pid" 2>/dev/null && exit_code=0 || exit_code=$?
  fi

  # Fire post-exit best-effort — failure never delays the respawn.
  run_post_exit_hooks "$slot" "${SLOT_WORKER_IDS[$slot]:-}" "$exit_code" "$lifetime"

  if (( spawn_at > 0 && lifetime < FAST_DEATH_THRESHOLD_S )); then
    local times="${SLOT_FAST_DEATHS[$slot]:-} $now"
    local pruned="" t
    for t in $times; do
      [[ -z "$t" ]] && continue
      (( now - t <= CIRCUIT_WINDOW_S )) && pruned+=" $t"
    done
    SLOT_FAST_DEATHS[$slot]="${pruned# }"
    SLOT_LAST_DEATH_EPOCH[$slot]="$now"
    local count; count="$(echo "${SLOT_FAST_DEATHS[$slot]}" | wc -w | tr -d ' ')"
    log "slot $slot: fast death (lifetime=${lifetime}s, ${count}/${CIRCUIT_K} in ${CIRCUIT_WINDOW_S}s window)"
    if (( count >= CIRCUIT_K )); then
      SLOT_PARKED[$slot]=1
      SLOT_TRIP_EPOCH[$slot]="$now"
      log "🔥 slot $slot parked after ${count} fast deaths in ${CIRCUIT_WINDOW_S}s — fix runner & restart"
      write_circuit_state
      sweep_parked_slot "$slot"
      return
    fi
  fi

  spawn_slot "$slot"
}

terminate_all() {
  local slot pid
  for slot in "${!SLOT_PIDS[@]}"; do
    pid="${SLOT_PIDS[$slot]}"
    [[ -n "$pid" ]] || continue
    if kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
      log "slot $slot: sent SIGTERM to pid=$pid"
    fi
  done
}

SHUTTING_DOWN=0
cleanup() {
  (( SHUTTING_DOWN )) && return
  SHUTTING_DOWN=1
  log "shutdown requested; terminating workers"
  terminate_all
  rm -f "$PID_FILE"
  rm -f "$CIRCUIT_FILE"
  rm -f "$DEFAULTS_FILE"
  [[ -f "$STOP_FILE" ]] && rm -f "$STOP_FILE"
  log "supervisor exiting"
  exit 0
}
# ---------- pre-spawn boot-log ----------
# Run the generic hook orchestrator's `pre-spawn` chain once at boot to
# announce which shipped detectors are applicable to this project. The
# call is made in a subshell so detector env exports never leak into the
# supervisor's own environment (per-slot env propagation is owned by
# spawn_slot's pre-spawn hook integration). Detectors that exited 1
# (not applicable) and detectors disabled via .red/config.yaml are
# omitted from the log line. The applied list is also persisted to
# DEFAULTS_FILE so monitor.sh can render the `defaults:` field correctly
# from the first refresh — even before any slot has spawned.
log_applied_detectors_boot_line() {
  local applied
  applied="$(
    RED_AFK_SLOT=0 \
    RED_AFK_PLUGIN_DIR="$PLUGIN_DIR" \
    PROJECT_ROOT="$PROJECT_ROOT" \
    bash -c "
      source '$SCRIPT_DIR/hooks.sh'
      hooks_run pre-spawn >/dev/null 2>&1 || true
      printf '%s' \"\${HOOKS_APPLIED_DETECTORS[*]}\"
    " 2>/dev/null
  )"
  write_defaults_file "$applied"
  if [[ -n "$applied" ]]; then
    log "pre-spawn: applied detectors [${applied// /, }]"
  fi
}

# When sourced (e.g. from test harnesses) skip the main loop so unit
# tests can exercise pure functions without spawning workers or grabbing
# the singleton lock. Every function above this line is reachable from
# `source supervisor.sh`.
#
# The cleanup trap is intentionally installed *below* the source-guard:
# sourcing supervisor.sh from a test must not hijack the test shell's
# SIGTERM handler. The live supervisor still installs the trap normally
# when run as `bash supervisor.sh …` (the source-guard returns before
# the trap line, but the main binary keeps reading past it).
[[ "${BASH_SOURCE[0]}" != "$0" ]] && return 0 2>/dev/null

trap cleanup SIGTERM SIGINT

# Pin the supervisor's PID for sup_kill_tree's blast-radius guard
# (#193). Tests source supervisor.sh and inherit the guard via the
# `${SUPERVISOR_PID:-$$}` fallback inside the function — they don't
# need this assignment because the source-guard returned above.
SUPERVISOR_PID="$$"

validate_stall_thresholds || exit $?

log_applied_detectors_boot_line

# ---------- main ----------
acquire_lock

for ((i=0; i<RED_AFK_TARGET; i++)); do
  spawn_slot "$i"
  (( i < RED_AFK_TARGET-1 )) && sleep "$STAGGER_S"
done

# Health-check loop: respawn dead slots, honour stop-file.
while :; do
  if [[ -f "$STOP_FILE" ]]; then
    log "stop file detected at $STOP_FILE"
    cleanup
  fi
  sleep "$POLL_S" &
  wait $! 2>/dev/null || true
  for ((i=0; i<RED_AFK_TARGET; i++)); do
    [[ "${SLOT_PARKED[$i]:-0}" == "1" ]] && continue
    pid="${SLOT_PIDS[$i]:-}"
    if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
      log "slot $i: worker pid=${pid:-none} not alive"
      handle_dead_slot "$i"
    fi
  done
  now_epoch="$(date +%s)"
  if (( now_epoch - LAST_STALL_POLL_EPOCH >= RED_AFK_STALL_POLL_S )); then
    poll_stall_detector
  fi
done
