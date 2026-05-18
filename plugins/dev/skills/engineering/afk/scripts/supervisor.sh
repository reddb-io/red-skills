#!/usr/bin/env bash
# /afk supervisor — maintains N concurrent /afk workers on a single checkout.
#
# Usage:
#   TARGET=2 bash supervisor.sh [project_root]
#
# Env:
#   TARGET — desired worker count (default 2)
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
# Per-slot build isolation: build tools that serialize on a single cache
# directory (cargo, Gradle, …) can stall the fleet. When the operator sets
# a recognised `*_BASE` env var, the supervisor creates and exports a
# slot-specific subdirectory (`${BASE}/slot-{i}`) for each worker so each
# slot compiles in its own cache. Nothing is created or exported when the
# base var is unset — non-Rust / non-Gradle projects pay zero cost.
#
# Supported per-slot build env vars (see BUILD_ISOLATION_VARS below):
#   CARGO_TARGET_BASE      → exports CARGO_TARGET_DIR=${BASE}/slot-{i}
#   GRADLE_USER_HOME_BASE  → exports GRADLE_USER_HOME=${BASE}/slot-{i}
# Adding a new tool is a one-line append to BUILD_ISOLATION_VARS.
#
# The supervisor only manages worker process lifecycle. Workers are normal
# `afk.sh` invocations and own all claim-lock / state / queue semantics.

set -eo pipefail

# ---------- discovery ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AFK_SH="$SCRIPT_DIR/afk.sh"
[[ -x "$AFK_SH" ]] || { echo "[supervisor] ERROR: afk.sh not found or not executable at $AFK_SH" >&2; exit 2; }

PROJECT_ROOT="${1:-$(pwd)}"
PROJECT_ROOT="$(cd "$PROJECT_ROOT" && pwd)"
TMP_DIR="$PROJECT_ROOT/.red/tmp"
mkdir -p "$TMP_DIR"

PID_FILE="$TMP_DIR/afk-supervisor.pid"
LOG_FILE="$TMP_DIR/afk-supervisor.log"
STOP_FILE="$TMP_DIR/afk-supervisor.stop"
CIRCUIT_FILE="$TMP_DIR/afk-supervisor-circuit.json"

TARGET="${TARGET:-2}"
STAGGER_S="${SUPERVISOR_STAGGER_S:-2}"
POLL_S="${SUPERVISOR_POLL_S:-15}"

# Circuit breaker tunables (overridable for tests).
FAST_DEATH_THRESHOLD_S="${SUPERVISOR_FAST_DEATH_S:-30}"
CIRCUIT_K="${SUPERVISOR_CIRCUIT_K:-5}"
CIRCUIT_WINDOW_S="${SUPERVISOR_CIRCUIT_WINDOW_S:-90}"

# Per-slot build-isolation env vars. Each entry is "BASE_VAR:TARGET_VAR".
# When BASE_VAR is set in the supervisor's env, every spawned worker on
# slot i gets TARGET_VAR=${BASE_VAR}/slot-{i} exported and the directory
# is `mkdir -p`'d before spawn. When BASE_VAR is unset, nothing happens
# for that pair — projects that don't compile with the tool see no side
# effects on their filesystem. Append a new line to support a new tool.
BUILD_ISOLATION_VARS=(
  "CARGO_TARGET_BASE:CARGO_TARGET_DIR"
  "GRADLE_USER_HOME_BASE:GRADLE_USER_HOME"
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
  log "acquired lock (pid=$$, target=$TARGET, project=$PROJECT_ROOT)"
}

# ---------- worker management ----------
declare -a SLOT_PIDS=()
declare -a SLOT_SPAWN_EPOCH=()
declare -a SLOT_FAST_DEATHS=()       # space-separated death epochs, pruned to window
declare -a SLOT_PARKED=()
declare -a SLOT_TRIP_EPOCH=()
declare -a SLOT_LAST_DEATH_EPOCH=()

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

spawn_slot() {
  local slot="$1"
  local slot_log="$TMP_DIR/afk-supervisor-slot-${slot}.log"
  local -a env_args=()
  local line
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    env_args+=("$line")
  done < <(build_slot_env_overrides "$slot")
  nohup env "${env_args[@]}" "$AFK_SH" "$PROJECT_ROOT" >>"$slot_log" 2>&1 </dev/null &
  local pid=$!
  SLOT_PIDS[$slot]=$pid
  SLOT_SPAWN_EPOCH[$slot]="$(date +%s)"
  if (( ${#env_args[@]} > 0 )); then
    log "slot $slot: spawned worker pid=$pid (log=$slot_log, env=${env_args[*]})"
  else
    log "slot $slot: spawned worker pid=$pid (log=$slot_log)"
  fi
}

# Write the parked-slot state file. Called whenever a slot trips.
write_circuit_state() {
  local entries=() i trip last count trip_iso last_iso
  for ((i=0; i<TARGET; i++)); do
    [[ "${SLOT_PARKED[$i]:-0}" == "1" ]] || continue
    trip="${SLOT_TRIP_EPOCH[$i]:-0}"
    last="${SLOT_LAST_DEATH_EPOCH[$i]:-0}"
    count="$(echo "${SLOT_FAST_DEATHS[$i]:-}" | wc -w | tr -d ' ')"
    trip_iso="$(date -Iseconds -d "@$trip" 2>/dev/null || echo "")"
    last_iso="$(date -Iseconds -d "@$last" 2>/dev/null || echo "")"
    entries+=("{\"slot\":$i,\"trip_at_epoch\":$trip,\"trip_at\":\"$trip_iso\",\"last_death_at_epoch\":$last,\"last_death_at\":\"$last_iso\",\"fast_deaths\":$count}")
  done
  local joined; joined="$(IFS=,; echo "${entries[*]}")"
  printf '{"parked":[%s]}\n' "$joined" > "$CIRCUIT_FILE"
}

# Handle a slot whose worker has exited: decide park-or-respawn based on
# fast-death history. A "fast death" is a worker that exited within
# < FAST_DEATH_THRESHOLD_S of being spawned. Hitting CIRCUIT_K such deaths
# inside CIRCUIT_WINDOW_S parks the slot — log a loud line, record state,
# and stop spawning. Slow deaths reset nothing in particular: the death-time
# ring naturally prunes anything older than the window on each pass.
handle_dead_slot() {
  local slot="$1"
  local now spawn_at lifetime
  now="$(date +%s)"
  spawn_at="${SLOT_SPAWN_EPOCH[$slot]:-0}"
  lifetime=$(( now - spawn_at ))

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
  [[ -f "$STOP_FILE" ]] && rm -f "$STOP_FILE"
  log "supervisor exiting"
  exit 0
}
trap cleanup SIGTERM SIGINT

# ---------- main ----------
acquire_lock

for ((i=0; i<TARGET; i++)); do
  spawn_slot "$i"
  (( i < TARGET-1 )) && sleep "$STAGGER_S"
done

# Health-check loop: respawn dead slots, honour stop-file.
while :; do
  if [[ -f "$STOP_FILE" ]]; then
    log "stop file detected at $STOP_FILE"
    cleanup
  fi
  sleep "$POLL_S" &
  wait $! 2>/dev/null || true
  for ((i=0; i<TARGET; i++)); do
    [[ "${SLOT_PARKED[$i]:-0}" == "1" ]] && continue
    pid="${SLOT_PIDS[$i]:-}"
    if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
      log "slot $i: worker pid=${pid:-none} not alive"
      handle_dead_slot "$i"
    fi
  done
done
