#!/usr/bin/env bash
# Unit tests for the periodic orchestrator heartbeat (issue #194).
#
# Verifies that lib/heartbeat.sh's heartbeat_start spawns a background
# sub-shell that appends one liveness line per RED_AFK_HEARTBEAT_S to
# ITER_LOG, that the loop survives a SIGSTOPped fake inner-agent
# (acceptance criterion: forcibly hung worker still produces heartbeat
# lines with wall-clock advancing and stage frozen), and that
# heartbeat_stop reaps the sub-shell deterministically.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="$HERE/../lib"

# shellcheck source=../lib/state.sh
source "$LIB_DIR/state.sh"
# shellcheck source=../lib/heartbeat.sh
source "$LIB_DIR/heartbeat.sh"
# shellcheck source=../lib/jsonl-log.sh
source "$LIB_DIR/jsonl-log.sh"   # firehose envelope writer (issue #250)

TMP_ROOT="$(mktemp -d -t heartbeat.XXXXXX)"
cleanup_root() {
  if [[ -n "${HEARTBEAT_PID:-}" ]]; then
    kill "$HEARTBEAT_PID" 2>/dev/null || true
    wait "$HEARTBEAT_PID" 2>/dev/null || true
  fi
  if [[ -n "${SLEEPER_PID:-}" ]]; then
    kill -CONT "$SLEEPER_PID" 2>/dev/null || true
    kill      "$SLEEPER_PID" 2>/dev/null || true
    wait      "$SLEEPER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup_root EXIT

pass=0
fail=0
ok()  { echo "PASS  $1"; pass=$((pass+1)); }
bad() { echo "FAIL  $1${2:+ ($2)}"; fail=$((fail+1)); }

# ---------- heartbeat_format_elapsed ----------

assert_fmt() {
  local label="$1" secs="$2" expect="$3" got
  got="$(heartbeat_format_elapsed "$secs")"
  if [[ "$got" == "$expect" ]]; then ok "$label"
  else bad "$label" "got=$got want=$expect"; fi
}
assert_fmt "format: 0s"      0     "00:00:00"
assert_fmt "format: 65s"     65    "00:01:05"
assert_fmt "format: 3742s"   3742  "01:02:22"

# ---------- heartbeat_emit_once shape ----------

STATE_FILE="$TMP_ROOT/state.json"
ITER_LOG="$TMP_ROOT/afk.log"
: > "$ITER_LOG"
state_init "$STATE_FILE" \
  current.stage=tests \
  current.last_stream_line='running pnpm test'

heartbeat_emit_once "$STATE_FILE" "$ITER_LOG" "$(( $(date +%s) - 842 ))" "$$"
line="$(tail -n 1 "$ITER_LOG")"

case "$line" in
  '[heartbeat] stage:tests t+00:14:02 last_stream_line="running pnpm test" cpu='*'% rss='*'M')
    ok "emit_once: line shape matches issue spec example"
    ;;
  *)
    bad "emit_once: line shape" "got=$line"
    ;;
esac

# Embedded double-quote must be escaped, not break the format.
state_write "$STATE_FILE" current.last_stream_line='he said "ok"'
heartbeat_emit_once "$STATE_FILE" "$ITER_LOG" "$(date +%s)" "$$"
last="$(tail -n 1 "$ITER_LOG")"
if [[ "$last" == *'last_stream_line="he said \"ok\""'* ]]; then
  ok "emit_once: quotes in stream line are escaped"
else
  bad "emit_once: quote escaping" "got=$last"
fi

# ---------- heartbeat vitals → firehose, never the agent lane (issue #250) ----------
# The heartbeat writes its vitals as a type=heartbeat JSONL record to the
# firehose so the full attempt story is reconstructable, but it must never
# touch the clean agent lane (which carries inner-agent output only) — that is
# what keeps the agent lane the true liveness signal (#243).
FIRE_HB="$TMP_ROOT/log.jsonl"
AGENT_HB="$TMP_ROOT/agent.log.jsonl"
: > "$FIRE_HB"
STATE_FB="$TMP_ROOT/state-fb.json"
state_init "$STATE_FB" current.stage=tests current.last_stream_line='running pnpm test'

heartbeat_emit_once "$STATE_FB" "$ITER_LOG" "$(( $(date +%s) - 130 ))" "$$" \
  "$FIRE_HB" wHB 250 1

if [[ "$(wc -l < "$FIRE_HB" | tr -d ' ')" == "1" ]] \
   && [[ "$(jq -r '.type' "$FIRE_HB")" == "heartbeat" ]]; then
  ok "firehose: heartbeat writes exactly one type=heartbeat record"
else
  bad "firehose heartbeat record" "got=$(cat "$FIRE_HB")"
fi

if [[ "$(jq -rc '[.worker,.issue,.attempt,.stage]' "$FIRE_HB")" == '["wHB",250,1,"tests"]' ]]; then
  ok "firehose: heartbeat record carries identity + stage vitals"
else
  bad "firehose heartbeat vitals" "got=$(jq -rc '[.worker,.issue,.attempt,.stage]' "$FIRE_HB")"
fi

if jq -e 'has("cpu") and has("rss") and has("elapsed")' "$FIRE_HB" >/dev/null 2>&1; then
  ok "firehose: heartbeat record carries cpu/rss/elapsed vitals"
else
  bad "firehose heartbeat cpu/rss/elapsed" "got=$(cat "$FIRE_HB")"
fi

if [[ ! -e "$AGENT_HB" ]]; then
  ok "agent lane: heartbeat never writes the agent lane"
else
  bad "agent lane touched by heartbeat" "exists=$AGENT_HB"
fi

# A heartbeat with no firehose arg still writes the plain ITER_LOG line only
# (back-compat: the 4-arg call site is unchanged).
fire_before_plain="$(grep -c '^\[heartbeat\] stage:' "$ITER_LOG" || true)"
heartbeat_emit_once "$STATE_FB" "$ITER_LOG" "$(date +%s)" "$$"
fire_after_plain="$(grep -c '^\[heartbeat\] stage:' "$ITER_LOG" || true)"
[[ "$fire_after_plain" -eq "$((fire_before_plain + 1))" && "$(wc -l < "$FIRE_HB" | tr -d ' ')" == "1" ]] \
  && ok "back-compat: 4-arg emit writes plain line only, firehose untouched" \
  || bad "back-compat 4-arg emit" "plain=$fire_before_plain→$fire_after_plain fire=$(wc -l < "$FIRE_HB")"

# ---------- heartbeat_start / heartbeat_stop loop ----------

# Fresh iter dir for the loop test.
ITER_DIR="$TMP_ROOT/iter"
mkdir -p "$ITER_DIR"
STATE_FILE="$ITER_DIR/afk.state.json"
ITER_LOG="$ITER_DIR/afk.log"
: > "$ITER_LOG"
state_init "$STATE_FILE" \
  current.stage=impl \
  current.last_stream_line='writing test'

# Acceptance: a worker forcibly hung still produces heartbeat lines. We
# simulate the hung inner agent with a sleeper and SIGSTOP it; the
# orchestrator heartbeat must keep ticking because it lives in a
# separate sub-shell, not in the inner pipeline.
sleep 60 &
SLEEPER_PID=$!
kill -STOP "$SLEEPER_PID"

RED_AFK_HEARTBEAT_S=1 heartbeat_start 194

if [[ -z "$HEARTBEAT_PID" ]]; then
  bad "start: HEARTBEAT_PID set"
else
  ok "start: HEARTBEAT_PID set ($HEARTBEAT_PID)"
fi

if kill -0 "$HEARTBEAT_PID" 2>/dev/null; then
  ok "start: background loop alive"
else
  bad "start: background loop alive"
fi

sleep 3.2

# Capture the periodic lines and flip the stage mid-stream to check that
# the loop is re-reading state on each tick rather than caching it.
periodic_before="$(grep -c '^\[heartbeat\] stage:' "$ITER_LOG" || true)"
state_write "$STATE_FILE" current.stage=tests
sleep 2.2

periodic_after="$(grep -c '^\[heartbeat] stage:' "$ITER_LOG" || true)"
if (( periodic_after >= periodic_before + 1 )); then
  ok "loop: heartbeats kept advancing after stage flip ($periodic_before → $periodic_after)"
else
  bad "loop: heartbeats not advancing" "before=$periodic_before after=$periodic_after"
fi

if grep -q '^\[heartbeat\] stage:impl '  "$ITER_LOG"; then
  ok "loop: emitted line with stage:impl"
else
  bad "loop: stage:impl line missing"
fi
if grep -q '^\[heartbeat\] stage:tests ' "$ITER_LOG"; then
  ok "loop: re-read state and emitted stage:tests"
else
  bad "loop: stage:tests line missing"
fi

# Wall-clock must advance even though the (fake) inner agent is STOPped.
mapfile -t tstamps < <(grep -oE 't\+[0-9]{2}:[0-9]{2}:[0-9]{2}' "$ITER_LOG" | sort -u)
if (( ${#tstamps[@]} >= 2 )); then
  ok "loop: wall-clock t+ advances across heartbeats (${#tstamps[@]} distinct)"
else
  bad "loop: wall-clock not advancing" "samples=${tstamps[*]:-<none>}"
fi

# Cleanly stop the loop and assert no further lines.
heartbeat_stop
sleep 1.5
after_stop="$(grep -c '^\[heartbeat\] stage:' "$ITER_LOG" || true)"
if (( after_stop == periodic_after )); then
  ok "stop: no new periodic lines after heartbeat_stop"
else
  bad "stop: lines added after stop" "was=$periodic_after now=$after_stop"
fi

if grep -q '^\[heartbeat\] iteration started for #194' "$ITER_LOG"; then
  ok "boundary: iteration-started marker present"
else
  bad "boundary: iteration-started marker missing"
fi
if grep -q '^\[heartbeat\] iteration stopped at '       "$ITER_LOG"; then
  ok "boundary: iteration-stopped marker present"
else
  bad "boundary: iteration-stopped marker missing"
fi

# Release the sleeper so the EXIT trap doesn't have to wait on a stuck pid.
kill -CONT "$SLEEPER_PID" 2>/dev/null || true
kill       "$SLEEPER_PID" 2>/dev/null || true
wait       "$SLEEPER_PID" 2>/dev/null || true
SLEEPER_PID=""

# ---------- empty ITER_LOG disables the loop ----------

ITER_LOG=""
HEARTBEAT_PID=""
RED_AFK_HEARTBEAT_S=1 heartbeat_start 999
if [[ -z "$HEARTBEAT_PID" ]]; then
  ok "disabled: no loop spawned when ITER_LOG empty"
else
  bad "disabled: loop spawned anyway" "pid=$HEARTBEAT_PID"
  kill "$HEARTBEAT_PID" 2>/dev/null || true
fi

# ---------- summary ----------
echo "---"
echo "passed=$pass failed=$fail"
exit "$fail"
