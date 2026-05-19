#!/usr/bin/env bash
# /afk supervisor — maintains N concurrent /afk workers on a single checkout.
#
# Usage:
#   RED_AFK_TARGET=2 bash supervisor.sh [project_root]
#
# Env:
#   RED_AFK_TARGET — desired worker count (default 2)
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
# inspects each live slot's per-iteration afk.log mtime. A slot whose
# worker has been alive ≥ RED_AFK_STALL_THRESHOLD_S *and* whose afk.log
# hasn't been written to in ≥ RED_AFK_STALL_THRESHOLD_S is flagged
# `stalled:true` in the state file. The supervisor does NOT kill or
# restart stalled workers — surfacing is the entire job. Monitor reads
# the same file and renders stalled slots distinctly. The flag clears
# automatically on the next sample once the log advances.
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

PROJECT_ROOT="${1:-$(pwd)}"
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

# gen_supervisor_wid — fresh `wXXXX` worker ID handed to pre-spawn hooks via
# RED_AFK_WORKER_ID. Distinct from the runtime WORKER_ID afk.sh picks for itself —
# this one only labels the spawn for detector / post-exit hook bookkeeping.
gen_supervisor_wid() {
  printf 'w%s' "$(LC_ALL=C tr -dc 'A-Z0-9' </dev/urandom | head -c 4)"
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

  nohup env "${env_args[@]}" "$AFK_SH" "$PROJECT_ROOT" >>"$slot_log" 2>&1 </dev/null &
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
# process. Workers create $TMP_DIR/work-<wid>-i<n>/afk.pid containing
# their PID for the lifetime of one iteration; we grep for the slot's
# pid across those files to find the live iteration directory. Echoes
# the absolute log path on success and nothing when the worker is
# between iterations (legitimately silent).
find_slot_iter_log() {
  local slot="$1"
  local pid="${SLOT_PIDS[$slot]:-}"
  local pid_file dir
  [[ -n "$pid" ]] || return 0
  for pid_file in "$TMP_DIR"/work-*/afk.pid; do
    [[ -f "$pid_file" ]] || continue
    [[ "$(cat "$pid_file" 2>/dev/null)" == "$pid" ]] || continue
    dir="$(dirname "$pid_file")"
    printf '%s\n' "$dir/afk.log"
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

# Sample every non-parked slot. Sets / clears SLOT_STALLED[slot] and
# rewrites the state file when any slot's stall flag flipped. No-op
# beyond bookkeeping — the supervisor must not act on stalled workers.
poll_stall_detector() {
  local now changed=0 i log mtime spawn flagged
  now="$(date +%s)"
  for ((i=0; i<RED_AFK_TARGET; i++)); do
    [[ "${SLOT_PARKED[$i]:-0}" == "1" ]] && continue
    spawn="${SLOT_SPAWN_EPOCH[$i]:-0}"
    log="$(find_slot_iter_log "$i")"
    mtime=0
    if [[ -n "$log" && -f "$log" ]]; then
      mtime="$(stat -c %Y "$log" 2>/dev/null || echo 0)"
    fi
    flagged="$(compute_stalled "$spawn" "$mtime" "$now" "$RED_AFK_STALL_THRESHOLD_S")"
    if [[ "$flagged" == "yes" ]]; then
      if [[ "${SLOT_STALLED[$i]:-0}" != "1" ]]; then
        SLOT_STALLED[$i]=1
        # Anchor the stall window to the last observed log activity so
        # the duration the monitor renders matches "log idle for N".
        SLOT_STALL_SINCE_EPOCH[$i]="$mtime"
        SLOT_STALL_LOG[$i]="$log"
        log "⏸️  slot $i flagged stalled (log idle for $(( now - mtime ))s: $log)"
        changed=1
      fi
    else
      if [[ "${SLOT_STALLED[$i]:-0}" == "1" ]]; then
        SLOT_STALLED[$i]=0
        SLOT_STALL_SINCE_EPOCH[$i]=0
        SLOT_STALL_LOG[$i]=""
        log "▶️  slot $i stall cleared (log advanced)"
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
# Echo every `.red/tmp/work-{wid}-i*/` directory that exists for the
# given worker ID. Multiple iter dirs per worker are possible when the
# worker drained several issues before its slot got parked.
iter_dirs_for_worker() {
  local wid="$1" d
  shopt -s nullglob
  for d in "$TMP_DIR"/work-"${wid}"-i*/; do
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

# build_discard_envelope <runner> <slot> <wids_csv> <fast_deaths> <log_path>
# Emits the full envelope body for the structured comment. Schema matches
# afk.sh's build_envelope (data-attempt-status + data-section blocks) so
# the envelope parser handles it without a new branch.
build_discard_envelope() {
  local runner="$1" slot="$2" wids="$3" deaths="$4" log_path="$5"
  local summary="runner \`${runner}\` · status: discarded · cause: runner-broken, slot parked after ${deaths} fast deaths"
  printf '<details data-attempt-status="discarded"><summary>%s</summary>\n\n' "$summary"
  printf '<details data-section="summary"><summary>summary</summary>\n\n'
  printf 'slot: %s\n' "$slot"
  printf 'worker IDs: %s\n' "$wids"
  printf 'fast deaths: %s\n' "$deaths"
  printf 'supervisor log: %s\n' "$log_path"
  printf '\n</details>\n\n'
  printf '</details>\n'
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

  local pair body affected_issues=()
  for pair in "${pairs[@]}"; do
    dir="${pair%%|*}"
    issue="${pair##*|}"
    if [[ -n "$issue" && "$issue" != "null" && -n "$repo" ]]; then
      body="$(build_discard_envelope "$SUPERVISOR_RUNNER" "$slot" "$wids_csv" "$deaths" "$sup_log_rel")"
      if gh -R "$repo" issue comment "$issue" --body "$body" >/dev/null 2>&1; then
        log "slot $slot sweep: posted discard envelope on #$issue"
      else
        log "slot $slot sweep: WARN failed to post envelope on #$issue"
      fi
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

trap cleanup SIGTERM SIGINT

# When sourced (e.g. from test harnesses) skip the main loop so unit
# tests can exercise pure functions without spawning workers or grabbing
# the singleton lock. Every function above this line is reachable from
# `source supervisor.sh`.
[[ "${BASH_SOURCE[0]}" != "$0" ]] && return 0 2>/dev/null

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
