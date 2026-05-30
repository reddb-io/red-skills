#!/usr/bin/env bash
# Tests for lib/attempt-reader.sh — the canonical attempt-exit reader
# (ADR 0028, issue #227).
#
# Drives the module against real stream-json fixtures and real subprocess
# trees (no mocks) so the detection predicate, the bounded tear-down
# (grace → SIGTERM → SIGKILL), and the foreground watch loop are exercised for
# what they are — actual kernel signal behaviour and jq/grep over the same
# capture shapes run_claude / run_codex feed them.
#
# Contract under test:
#   - attempt_reader_outcome_from_line maps a sentinel line to done / blocked /
#     no_more_tasks and refuses non-sentinel lines.
#   - attempt_reader_detect matches only the line-anchored final sentinel
#     (not a quoted mention in planning prose) over both Claude and Codex
#     stream-json shapes, and returns 1 while the file has no sentinel yet.
#   - attempt_reader_teardown waits the grace window for a clean exit, then
#     SIGTERMs, then SIGKILLs — and is a fast no-op when the pid already exited.
#   - attempt_reader_watch (daemonising agent): a child that emits the sentinel
#     and then holds the pipe open via a backgrounded sleep is detected and
#     torn down within the grace window; ATTEMPT_READER_OUTCOME=done.
#   - attempt_reader_watch (EOF without sentinel): the pipe closing before any
#     sentinel leaves ATTEMPT_READER_OUTCOME empty (→ on_attempt_error).
#   - afk.sh's run_claude / run_codex call attempt_reader_watch and no longer
#     wait on the bare pipe.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
AR_SH="$HERE/../lib/attempt-reader.sh"
AFK_SH="$HERE/../afk.sh"
FIXTURES="$HERE/fixtures"

CLAUDE_JQ='select(.type == "assistant").message.content[]? | select(.type == "text").text // empty'
CODEX_JQ='select(.type == "item.completed") | .item.text // empty'

# Small windows so the real-time waits stay sub-second-ish in CI.
export RED_AFK_ATTEMPT_GRACE_S=2
export RED_AFK_ATTEMPT_KILL_S=1
export RED_AFK_ATTEMPT_POLL_S=1

# shellcheck disable=SC1090
source "$AR_SH"

pass=0
fail=0
ok()  { echo "PASS  $1"; pass=$((pass + 1)); }
bad() { echo "FAIL  $1${2:+ ($2)}"; fail=$((fail + 1)); }

expect_eq() {
  local label="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then ok "$label"; else bad "$label" "got=>>$got<< want=>>$want<<"; fi
}

# Wait up to ~3s for `kill -0 $pid` to start failing (pid gone).
wait_dead() {
  local pid="$1" i
  for i in $(seq 1 30); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
  done
  return 1
}

# ---------- 1. outcome_from_line ----------
expect_eq "outcome_from_line DONE"          "$(attempt_reader_outcome_from_line '<promise>DONE</promise>')"          "done"
expect_eq "outcome_from_line BLOCKED"       "$(attempt_reader_outcome_from_line '<promise>BLOCKED</promise>')"       "blocked"
expect_eq "outcome_from_line NO MORE TASKS" "$(attempt_reader_outcome_from_line '<promise>NO MORE TASKS</promise>')" "no_more_tasks"
if attempt_reader_outcome_from_line 'just some prose' >/dev/null 2>&1; then
  bad "outcome_from_line rejects non-sentinel"
else
  ok "outcome_from_line rejects non-sentinel"
fi

# ---------- 2. detect over stream-json fixtures ----------
expect_eq "detect claude final DONE"    "$(attempt_reader_detect "$FIXTURES/claude-final-done.jsonl"    "$CLAUDE_JQ")" "done"
expect_eq "detect claude final BLOCKED" "$(attempt_reader_detect "$FIXTURES/claude-final-blocked.jsonl" "$CLAUDE_JQ")" "blocked"
expect_eq "detect codex final DONE"     "$(attempt_reader_detect "$FIXTURES/codex-final-done.jsonl"     "$CODEX_JQ")"  "done"

if attempt_reader_detect "$FIXTURES/claude-mention-only.jsonl" "$CLAUDE_JQ" >/dev/null 2>&1; then
  bad "detect ignores quoted mention (claude)"
else
  ok "detect ignores quoted mention (claude)"
fi
if attempt_reader_detect "$FIXTURES/codex-mention-only.jsonl" "$CODEX_JQ" >/dev/null 2>&1; then
  bad "detect ignores quoted mention (codex)"
else
  ok "detect ignores quoted mention (codex)"
fi
# Empty / absent capture → no match, no crash.
empty="$(mktemp)"
if attempt_reader_detect "$empty" "$CLAUDE_JQ" >/dev/null 2>&1; then
  bad "detect returns 1 on empty capture"
else
  ok "detect returns 1 on empty capture"
fi
rm -f "$empty"

# ---------- 3. teardown: fast no-op when pid already gone ----------
sleep 0.01 &
gone_pid=$!
wait "$gone_pid" 2>/dev/null || true
t0=$SECONDS
attempt_reader_teardown "$gone_pid" 5 5
expect_eq "teardown no-op when pid already dead (rc fast)" "$(( SECONDS - t0 < 2 ? 1 : 0 ))" "1"

# ---------- 4. teardown: SIGTERM then SIGKILL on a stubborn tree ----------
# A child that traps and ignores SIGTERM must still die via SIGKILL inside
# grace + kill windows. Layout: stubborn (bash, ignores TERM) → sleep 600.
stub_root="$(mktemp -d)"
bash -c '
  trap "" TERM
  sleep 600 &
  echo $! > '"$stub_root"'/gc.pid
  wait
' &
STUB_PID=$!
for _ in $(seq 1 20); do [[ -s "$stub_root/gc.pid" ]] && break; sleep 0.1; done
GC_PID="$(cat "$stub_root/gc.pid" 2>/dev/null || echo "")"
if [[ -n "$GC_PID" ]] && kill -0 "$GC_PID" 2>/dev/null; then
  ok "teardown setup: stubborn grandchild spawned"
else
  bad "teardown setup: stubborn grandchild missing" "gc=${GC_PID:-empty}"
fi
# grace=1, kill=1 → TERM ignored, KILL reaps within ~2s.
attempt_reader_teardown "$STUB_PID" 1 1
if wait_dead "$STUB_PID"; then ok "teardown SIGKILLs a TERM-ignoring parent"; else bad "teardown left parent alive"; fi
if wait_dead "$GC_PID";   then ok "teardown reaps the grandchild too";    else bad "teardown left grandchild alive"; fi
wait "$STUB_PID" 2>/dev/null || true
rm -rf "$stub_root"

# ---------- 5. watch: daemonising agent (sentinel + held-open pipe) ----------
# The child writes a claude-shaped DONE event into the capture file, emits the
# sentinel, then backgrounds a `sleep 600` that inherits the pipe — modelling
# an agent that says DONE and leaves a daemon running. The watch must detect
# DONE and tear the whole tree down within the grace window, setting
# ATTEMPT_READER_OUTCOME=done.
daemon_root="$(mktemp -d)"
cap="$daemon_root/capture.jsonl"
: > "$cap"
(
  # final assistant message carrying the line-anchored sentinel
  printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"<promise>DONE</promise>"}]}}' >> "$cap"
  sleep 600 &
  echo $! > "$daemon_root/daemon.pid"
  wait
) &
DAEMON_PID=$!
t0=$SECONDS
attempt_reader_watch "$DAEMON_PID" "$cap" "$CLAUDE_JQ"
elapsed=$(( SECONDS - t0 ))
expect_eq "watch records outcome=done for daemonising agent" "$ATTEMPT_READER_OUTCOME" "done"
expect_eq "watch returns within grace window (<=5s)" "$(( elapsed <= 5 ? 1 : 0 ))" "1"
if wait_dead "$DAEMON_PID"; then ok "watch tore down the daemonising pipeline"; else bad "watch left daemonising pipeline alive"; fi
DPID="$(cat "$daemon_root/daemon.pid" 2>/dev/null || echo "")"
if [[ -n "$DPID" ]]; then
  if wait_dead "$DPID"; then ok "watch killed the backgrounded daemon (sleep 600)"; else bad "watch left the daemon alive"; fi
fi
wait "$DAEMON_PID" 2>/dev/null || true
rm -rf "$daemon_root"

# ---------- 6. watch: EOF without sentinel → empty outcome ----------
# The child writes a non-sentinel event and exits cleanly (pipe EOF) without
# ever emitting <promise>. ATTEMPT_READER_OUTCOME must stay empty so the
# caller routes it to on_attempt_error.
eof_root="$(mktemp -d)"
ecap="$eof_root/capture.jsonl"
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"still working, no sentinel yet"}]}}' > "$ecap"
( exit 0 ) &
EOF_PID=$!
wait "$EOF_PID" 2>/dev/null || true
attempt_reader_watch "$EOF_PID" "$ecap" "$CLAUDE_JQ"
expect_eq "watch leaves outcome empty on EOF-without-sentinel" "$ATTEMPT_READER_OUTCOME" ""
rm -rf "$eof_root"

# ---------- 7. afk.sh wiring: adapters call the reader, not a bare pipe wait ----------
if grep -q 'source "\$SCRIPT_DIR/lib/attempt-reader.sh"' "$AFK_SH"; then
  ok "afk.sh sources lib/attempt-reader.sh"
else
  bad "afk.sh does not source lib/attempt-reader.sh"
fi
expect_eq "run_claude / run_codex call attempt_reader_watch (2 sites)" \
  "$(grep -c 'attempt_reader_watch "\$pipe_pid"' "$AFK_SH")" "2"
expect_eq "no bare \`wait \$pipe_pid\` before the reader (watchdog model removed)" \
  "$(grep -c 'run_sentinel_watchdog' "$AFK_SH")" "0"

# process_issue routing (ADR 0028):
#   - the terminal post_attempt carries the parsed sentinel outcome,
#   - EOF-without-sentinel routes through the single on_attempt_error site,
#   - the old standalone no-sentinel blocker branch is gone.
if grep -q '_afk_fire_post_attempt "\$n" "\$title" "\$worktree" "\$_pw_status" "\$attempt" "\$_sentinel_outcome"' "$AFK_SH"; then
  ok "terminal post_attempt passes \$_sentinel_outcome"
else
  bad "terminal post_attempt does not pass \$_sentinel_outcome"
fi
if grep -q '_eof_no_sentinel == 1' "$AFK_SH"; then
  ok "on_attempt_error gate routes EOF-without-sentinel"
else
  bad "EOF-without-sentinel not routed to on_attempt_error"
fi
expect_eq "single on_attempt_error dispatch site preserved" \
  "$(grep -c 'hook_dispatch on_attempt_error' "$AFK_SH")" "1"
expect_eq "dead 'ended without DONE sentinel' blocker branch removed" \
  "$(grep -c 'ended without DONE sentinel' "$AFK_SH")" "0"

echo
echo "summary: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
