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
#   afk-supervisor.pid          — supervisor PID (single-supervisor lock)
#   afk-supervisor.log          — supervisor event log
#   afk-supervisor.stop         — touch to request graceful shutdown
#   afk-supervisor-slot-N.log   — per-slot worker stdout/stderr
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

TARGET="${TARGET:-2}"
STAGGER_S="${SUPERVISOR_STAGGER_S:-2}"
POLL_S="${SUPERVISOR_POLL_S:-15}"

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
  log "acquired lock (pid=$$, target=$TARGET, project=$PROJECT_ROOT)"
}

# ---------- worker management ----------
declare -a SLOT_PIDS=()

spawn_slot() {
  local slot="$1"
  local slot_log="$TMP_DIR/afk-supervisor-slot-${slot}.log"
  nohup "$AFK_SH" "$PROJECT_ROOT" >>"$slot_log" 2>&1 </dev/null &
  local pid=$!
  SLOT_PIDS[$slot]=$pid
  log "slot $slot: spawned worker pid=$pid (log=$slot_log)"
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
    pid="${SLOT_PIDS[$i]:-}"
    if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
      log "slot $i: worker pid=${pid:-none} not alive; respawning"
      spawn_slot "$i"
    fi
  done
done
