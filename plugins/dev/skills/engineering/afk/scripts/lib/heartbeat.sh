#!/usr/bin/env bash
# lib/heartbeat.sh — periodic orchestrator heartbeat into ITER_LOG.
#
# Issue #194. Boundary markers alone ("iteration started" / "iteration
# stopped") leave a 30-minute void in afk.log when the inner-agent stdout
# stream buffers inside the runner pipeline and never flushes. A side-
# channel orchestrator loop guarantees one liveness line per minute
# regardless of inner-agent state — even when the inner is SIGSTOPped
# or the runner's tee never gets flushed before the reaper kills the
# tree.
#
# Public surface (sourced by afk.sh):
#
#   heartbeat_start N
#     Writes the "iteration started for #N" marker and spawns a
#     background sub-shell that appends one line every
#     RED_AFK_HEARTBEAT_S (default 60) seconds to $ITER_LOG. Each line:
#
#       [heartbeat] stage:STAGE t+HH:MM:SS last_stream_line="..." cpu=N% rss=NM
#
#     stage / last_stream_line come from afk.state.json via
#     state_read_into; cpu / rss come from `ps` on the orchestrator pid.
#     PID is stored in HEARTBEAT_PID. When a FIREHOSE lane is set (issue
#     #250), each tick also appends a type=heartbeat JSONL envelope carrying
#     the same vitals to the firehose — but never to the clean agent lane,
#     so the agent lane stays the true liveness signal (#243).
#
#   heartbeat_stop
#     SIGTERMs the sub-shell, waits, and writes the
#     "iteration stopped" marker.
#
# Disabled when ITER_LOG is empty (used during smoke paths that have no
# iteration dir) or when RED_AFK_HEARTBEAT_S=0.

HEARTBEAT_PID=""

heartbeat_format_elapsed() {
  local secs="$1"
  [[ "$secs" =~ ^[0-9]+$ ]] || secs=0
  printf '%02d:%02d:%02d' "$((secs/3600))" "$(((secs%3600)/60))" "$((secs%60))"
}

heartbeat_proc_metrics() {
  # Best-effort %cpu and rss-KB for the orchestrator pid. Returns "0 0"
  # if `ps` fails or the pid is gone — never aborts the caller.
  local pid="$1"
  if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then echo "0 0"; return; fi
  local out
  out="$(ps -o %cpu=,rss= -p "$pid" 2>/dev/null | head -n 1)" || out=""
  if [[ -z "$out" ]]; then echo "0 0"; return; fi
  local cpu rss
  read -r cpu rss <<<"$out"
  printf '%s %s\n' "${cpu:-0}" "${rss:-0}"
}

heartbeat_emit_once() {
  local statefile="$1" iterlog="$2" started_epoch="$3" orch_pid="$4"
  # Optional firehose lane + identity (issue #250). When a firehose path is
  # given and the JSONL writer is in scope, the same vitals this function
  # appends to ITER_LOG as a plain line are also appended to the firehose as a
  # type=heartbeat envelope — so the full attempt story is reconstructable.
  # The heartbeat NEVER writes the clean agent lane: that lane carries inner-
  # agent output only and is the true liveness signal (#243).
  local firehose="${5:-}" hb_worker="${6:-}" hb_issue="${7:-0}" hb_attempt="${8:-0}"
  local now elapsed elapsed_fmt
  now="$(date +%s)"
  elapsed=$((now - started_epoch))
  elapsed_fmt="$(heartbeat_format_elapsed "$elapsed")"

  local _hb_current_stage="" _hb_current_last_stream_line=""
  if declare -F state_read_into >/dev/null 2>&1 && [[ -n "$statefile" ]]; then
    state_read_into _hb "$statefile" 2>/dev/null || true
  fi
  local stage="${_hb_current_stage:-?}"
  local stream="${_hb_current_last_stream_line:-}"
  # Trim and escape embedded quotes so the line stays parseable.
  stream="${stream//\"/\\\"}"
  stream="${stream//$'\n'/ }"

  local metrics cpu_raw rss_kb cpu_int rss_mb
  metrics="$(heartbeat_proc_metrics "$orch_pid")"
  cpu_raw="${metrics%% *}"
  rss_kb="${metrics##* }"
  cpu_int="$(awk -v v="$cpu_raw" 'BEGIN{printf "%d", v+0}')"
  rss_mb="$(awk -v v="$rss_kb"  'BEGIN{printf "%d", (v+0)/1024}')"

  printf '[heartbeat] stage:%s t+%s last_stream_line="%s" cpu=%s%% rss=%sM\n' \
    "$stage" "$elapsed_fmt" "$stream" "$cpu_int" "$rss_mb" >> "$iterlog"

  # Mirror the vitals to the firehose as a type=heartbeat record. The firehose
  # is multi-writer within an attempt (this loop + the agent fanout + the
  # orchestrator's timing/error/hook records), so the write is flock-serialised
  # to never interleave a line. Best-effort: a firehose write must never crash
  # the heartbeat loop, hence `|| true`.
  if [[ -n "$firehose" ]] && declare -F jsonl_log_append_shared >/dev/null 2>&1; then
    jsonl_log_append_shared "$firehose" heartbeat "stage:$stage t+$elapsed_fmt" \
      worker="$hb_worker" issue="$hb_issue" attempt="$hb_attempt" \
      stage="$stage" elapsed="$elapsed_fmt" cpu="$cpu_int" rss="$rss_mb" \
      last_stream_line="$stream" 2>/dev/null || true
  fi
}

heartbeat_start() {
  local n="$1"
  [[ -n "$ITER_LOG" ]] || return 0
  printf '[heartbeat] iteration started for #%s at %s\n' \
    "$n" "$(date -Is)" >> "$ITER_LOG"
  local interval="${RED_AFK_HEARTBEAT_S:-60}"
  [[ "$interval" =~ ^[0-9]+$ ]] || interval=60
  (( interval > 0 )) || return 0
  local started_epoch
  started_epoch="$(date +%s)"
  local statefile="$STATE_FILE" iterlog="$ITER_LOG" orch_pid="$$"
  # Firehose lane + identity (issue #250): the loop mirrors each vital to the
  # firehose as a type=heartbeat record. Empty FIREHOSE → plain ITER_LOG only,
  # exactly as before.
  local firehose="${FIREHOSE:-}" hb_worker="${WORKER_ID:-}" \
        hb_issue="${CURRENT_ISSUE:-0}" hb_attempt="${CURRENT_ATTEMPT:-0}"
  (
    # Each iteration of the loop is an independent best-effort emit —
    # failure to read state / ps must never crash the loop, otherwise a
    # transient state-file rename (atomic-mv during state_write) could
    # silently terminate the heartbeat for the rest of the iteration.
    while sleep "$interval"; do
      [[ -f "$iterlog" ]] || exit 0
      kill -0 "$orch_pid" 2>/dev/null || exit 0
      heartbeat_emit_once "$statefile" "$iterlog" "$started_epoch" "$orch_pid" \
        "$firehose" "$hb_worker" "$hb_issue" "$hb_attempt" \
        2>/dev/null || true
    done
  ) &
  HEARTBEAT_PID=$!
  disown "$HEARTBEAT_PID" 2>/dev/null || true
}

heartbeat_stop() {
  if [[ -n "$HEARTBEAT_PID" ]]; then
    kill "$HEARTBEAT_PID" 2>/dev/null || true
    wait "$HEARTBEAT_PID" 2>/dev/null || true
    HEARTBEAT_PID=""
  fi
  [[ -n "$ITER_LOG" ]] && printf '[heartbeat] iteration stopped at %s\n' \
    "$(date -Is)" >> "$ITER_LOG"
  return 0
}
