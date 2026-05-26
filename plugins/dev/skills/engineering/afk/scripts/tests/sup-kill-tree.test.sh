#!/usr/bin/env bash
# Regression test for sup_kill_tree's blast radius (issue #193).
#
# #190 added the hard stall reaper, which calls sup_kill_tree on the
# orchestrator pid. In production we observed the *supervisor itself*
# dying shortly after a reap fired, leaving the PID file behind and the
# slot un-respawned. The kill_tree walker must:
#
#   1. Tear down the orchestrator's descendant tree (children,
#      grandchildren, …).
#   2. Leave the supervisor process strictly alive — even if a caller
#      mistakenly hands sup_kill_tree the supervisor's own PID, or PID
#      reuse / a stray recursion arg points back at it.
#   3. Refuse to signal PID 0 (process group of caller), PID 1 (init),
#      empty / non-numeric pids, or its own BASHPID. These are the
#      single-shot foot-guns that would take the whole fleet down.
#
# The test stages a real subprocess tree under the test shell (which
# plays the supervisor) and exercises sup_kill_tree directly. No stubs:
# we want to see the function's actual signal behaviour against the
# kernel, not a mock.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SUP_SH="$HERE/../supervisor.sh"

TMP_ROOT="$(mktemp -d -t sup-kill-tree.XXXXXX)"
trap 'rm -rf "$TMP_ROOT"' EXIT
mkdir -p "$TMP_ROOT/.red/tmp"

# shellcheck disable=SC1090
source "$SUP_SH" "$TMP_ROOT"

pass=0
fail=0
ok()  { echo "PASS  $1"; pass=$((pass+1)); }
bad() { echo "FAIL  $1${2:+ ($2)}"; fail=$((fail+1)); }

# Wait up to ~2s for `kill -0 $pid` to start *failing* (i.e. the pid is
# gone). Returns 0 if dead within the window, 1 otherwise.
wait_dead() {
  local pid="$1" i
  for i in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
  done
  return 1
}

# ---------- 1. real-tree teardown ----------
#
# Layout:
#   $$ (test shell, plays supervisor)
#   └─ orch (bash, plays orchestrator)
#      └─ grandchild (sleep, plays inner agent / tool subshell)
#
# sup_kill_tree must reap orch + grandchild and leave $$ alive.

SUP_PID="$$"

bash -c '
  sleep 600 &
  echo $! > '"$TMP_ROOT"'/gc.pid
  wait
' &
ORCH_PID=$!

# Give the grandchild time to materialise.
for _ in $(seq 1 20); do
  [[ -s "$TMP_ROOT/gc.pid" ]] && break
  sleep 0.1
done
GC_PID="$(cat "$TMP_ROOT/gc.pid" 2>/dev/null || echo "")"

if [[ -n "$GC_PID" ]] && kill -0 "$GC_PID" 2>/dev/null; then
  ok "setup: grandchild spawned (pid=$GC_PID)"
else
  bad "setup: grandchild missing" "gc.pid=${GC_PID:-empty}"
fi
kill -0 "$ORCH_PID" 2>/dev/null && ok "setup: orch alive (pid=$ORCH_PID)" || bad "setup: orch missing"

# Reap the tree.
sup_kill_tree "$ORCH_PID" TERM
# Match the production escalation: TERM then a brief grace then KILL.
sleep 0.5
if kill -0 "$ORCH_PID" 2>/dev/null; then
  sup_kill_tree "$ORCH_PID" KILL
fi

if wait_dead "$ORCH_PID"; then ok "kill_tree: orch killed"; else bad "kill_tree: orch survived"; fi
if wait_dead "$GC_PID";   then ok "kill_tree: grandchild killed"; else bad "kill_tree: grandchild survived"; fi

# The whole point of #193 — supervisor PID survives.
if kill -0 "$SUP_PID" 2>/dev/null; then
  ok "kill_tree: supervisor PID survives (no blast-radius leak)"
else
  bad "kill_tree: supervisor PID killed" "the regression #193 was reported for"
fi

# Reap orch zombie so the next stage starts clean.
wait "$ORCH_PID" 2>/dev/null || true

# ---------- 2. defensive guards ----------
#
# Even if a caller hands sup_kill_tree the supervisor PID directly (PID
# reuse, recursion bug, bookkeeping corruption), the function must
# refuse. Same for PID 0 (sending a signal to PID 0 hits the *process
# group* of the caller — which is the supervisor's pgrp, since `nohup`
# does not setsid the orchestrator), PID 1, empty/non-numeric input,
# and the function's own BASHPID.

# 2a. sup_kill_tree against the supervisor's own PID is a no-op.
sup_kill_tree "$SUP_PID" TERM
if kill -0 "$SUP_PID" 2>/dev/null; then
  ok "guard: sup_kill_tree refuses to signal supervisor PID (\$\$=$SUP_PID)"
else
  bad "guard: sup_kill_tree signalled own supervisor PID"
fi

# 2b. PID 0 must never be signalled (foot-gun — hits caller's pgrp).
sup_kill_tree 0 TERM
if kill -0 "$SUP_PID" 2>/dev/null; then
  ok "guard: sup_kill_tree refuses pid=0 (pgrp foot-gun)"
else
  bad "guard: sup_kill_tree pid=0 took down the supervisor's pgrp"
fi

# 2c. PID 1 (init) must never be signalled.
#     We can't actually verify init is alive — but we can verify
#     sup_kill_tree returns cleanly and the supervisor survives.
sup_kill_tree 1 TERM
kill -0 "$SUP_PID" 2>/dev/null && ok "guard: sup_kill_tree refuses pid=1 (init)" \
  || bad "guard: sup_kill_tree pid=1 took down the supervisor"

# 2d. Empty pid — must not error under `set -e`, must not signal anything.
sup_kill_tree "" TERM
kill -0 "$SUP_PID" 2>/dev/null && ok "guard: sup_kill_tree refuses empty pid" \
  || bad "guard: sup_kill_tree empty pid killed the supervisor"

# 2e. Non-numeric pid — defensive against bookkeeping corruption.
sup_kill_tree "not-a-pid" TERM
kill -0 "$SUP_PID" 2>/dev/null && ok "guard: sup_kill_tree refuses non-numeric pid" \
  || bad "guard: sup_kill_tree non-numeric pid killed the supervisor"

# 2f. Negative pid — would target a process group; must be refused.
sup_kill_tree "-1" TERM
kill -0 "$SUP_PID" 2>/dev/null && ok "guard: sup_kill_tree refuses negative pid" \
  || bad "guard: sup_kill_tree negative pid killed the supervisor"

echo
echo "summary: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
