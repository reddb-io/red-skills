#!/usr/bin/env bash
# Unit tests for the hard stall reaper wired into supervisor.sh
# (issue #190). Exercises:
#
#   - validate_stall_thresholds — boot-time invariant.
#   - poll_stall_detector + reap_stalled_slot — once a slot has been
#     silent past RED_AFK_STALL_KILL_THRESHOLD_S, the supervisor kills
#     the orchestrator tree, posts a `no-sentinel` envelope, rotates
#     labels back to `ready-for-agent`, and frees the slot's PID for
#     the next health-check respawn.
#   - SLOT_REAPED guard — re-running the poll on the same stalled slot
#     does not re-reap (no second envelope, no second kill).
#
# Network-touching paths are stubbed: `gh` writes call lines to a
# fixture file and never touches the wire. `git` calls are stubbed for
# the same reason (worktree remove / branch -D would otherwise need a
# real repo here).

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SUP_SH="$HERE/../supervisor.sh"

TMP_ROOT="$(mktemp -d -t stall-reaper.XXXXXX)"
trap 'rm -rf "$TMP_ROOT"' EXIT
mkdir -p "$TMP_ROOT/.red/tmp"

# shellcheck disable=SC1090
source "$SUP_SH" "$TMP_ROOT"

pass=0
fail=0

ok()   { echo "PASS  $1"; pass=$((pass+1)); }
bad()  { echo "FAIL  $1${2:+ ($2)}"; fail=$((fail+1)); }

assert_eq() {
  local label="$1" expect="$2" got="$3"
  if [ "$expect" = "$got" ]; then ok "$label"; else bad "$label" "expect=$expect got=$got"; fi
}

assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  if grep -qF -- "$needle" <<<"$haystack"; then ok "$label"
  else bad "$label" "missing: $needle"; fi
}

# ---------- validate_stall_thresholds ----------

RED_AFK_STALL_THRESHOLD_S=600
RED_AFK_STALL_KILL_THRESHOLD_S=1800
if validate_stall_thresholds 2>/dev/null; then ok "validate: default kill > stall passes"; else bad "validate: default rejected"; fi

RED_AFK_STALL_THRESHOLD_S=600
RED_AFK_STALL_KILL_THRESHOLD_S=600
if validate_stall_thresholds 2>/dev/null; then bad "validate: equal thresholds should fail"; else ok "validate: equal thresholds rejected"; fi

RED_AFK_STALL_THRESHOLD_S=600
RED_AFK_STALL_KILL_THRESHOLD_S=300
if validate_stall_thresholds 2>/dev/null; then bad "validate: kill < stall should fail"; else ok "validate: kill < stall rejected"; fi

# ---------- reap_stalled_slot end-to-end (with stubs) ----------

# Stub gh + git so the reap chain stays local.
GH_CALLS="$TMP_ROOT/gh.calls"
GIT_CALLS="$TMP_ROOT/git.calls"
: >"$GH_CALLS"; : >"$GIT_CALLS"

gh() {
  printf '%s\n' "$*" >>"$GH_CALLS"
  case "$1" in
    repo) printf 'reddb-io/red-skills\n' ;;
    *)    return 0 ;;
  esac
}
export -f gh

git() {
  printf '%s\n' "$*" >>"$GIT_CALLS"
  return 0
}
export -f git

# Stage one stalled slot. Use this shell's PID as the "orchestrator pid"
# so `kill -0` passes; sup_kill_tree's `kill -TERM` is harmless against
# our own process (we trap SIGTERM via the supervisor's cleanup? — no,
# the source-guard prevents the trap install) so override sup_kill_tree
# to neuter the actual signal in this test.
sup_kill_tree() {
  printf 'sup_kill_tree %s %s\n' "$1" "${2:-TERM}" >>"$TMP_ROOT/kill.calls"
  return 0
}

# Gate samplers (issue #251): the reap is now gated behind reaper_signal_decide,
# which the supervisor feeds from sup_active_descendant + sup_tree_cpu. Stub
# both to "genuinely stuck" (no build/test descendant, flat cpu) so this
# end-to-end reaper test exercises the kill path deterministically without a
# live process tree. The busy-worker (no-kill) branch is covered separately in
# stall-agent-lane.test.sh.
sup_active_descendant() { echo no; }
sup_tree_cpu() { echo 0; }

# Stage the iter dir as a real worker would: afk.pid + afk.state.json +
# afk.log + handoff.md.
RED_AFK_TARGET=1
RED_AFK_STALL_THRESHOLD_S=30
RED_AFK_STALL_KILL_THRESHOLD_S=90
SUPERVISOR_RUNNER="claude"

WID="wTEST"
ISSUE=190
SLUG="bug-afk-supervisor-stall"
# Nested layout (#252): attempt dir under workers/{wid}/, slot pid lives in the
# per-worker workers/{wid}/worker.pid that find_slot_iter_dir matches.
ITER_DIR="$TMP_ROOT/.red/tmp/workers/${WID}/${ISSUE}-a1"
mkdir -p "$ITER_DIR/worktree"
echo "$$" > "$(dirname "$ITER_DIR")/worker.pid"
cat > "$ITER_DIR/afk.state.json" <<EOF
{
  "worker_id": "$WID",
  "started_at": "$(date -Iseconds -d '@'$(( $(date +%s) - 200 )))",
  "current": {
    "number": $ISSUE,
    "title": "bug(afk): supervisor stall is surfacing-only",
    "slug": "$SLUG"
  }
}
EOF
cat > "$ITER_DIR/afk.log" <<'EOF'
[afk] iteration boot
[afk] worker: wTEST
[afk] inner: stalled tool call — never returns
EOF
# The agent lane is the liveness signal poll_stall_detector samples (#251); the
# reaper still reads afk.log above for the envelope's log tail. Stage the lane
# so the slot stays flagged when poll recomputes from it.
echo '{"type":"agent","msg":"last turn before the stall"}' > "$ITER_DIR/agent.log.jsonl"
cat > "$ITER_DIR/handoff.md" <<'EOF'
# Issue #190
<agent-notes>
mid-iteration progress note — pre-existing.
</agent-notes>
EOF

# Hand the slot the same PID written to afk.pid.
SLOT_PIDS=("$$")
SLOT_SPAWN_EPOCH=("$(( $(date +%s) - 200 ))")
SLOT_STALLED=(1)
SLOT_STALL_SINCE_EPOCH=("$(( $(date +%s) - 120 ))")  # silent 120s, past KILL=90
SLOT_STALL_LOG=("$ITER_DIR/afk.log")
SLOT_REAPED=(0)
SLOT_PARKED=(0)
SLOT_SWEPT=(0)

# Back-date the agent-lane mtime to before the kill window so compute_stalled
# still returns yes inside poll_stall_detector. afk.log stays fresh (as a live
# heartbeat would keep it) to prove liveness is read from the lane, not afk.log.
touch -d "@$(( $(date +%s) - 120 ))" "$ITER_DIR/agent.log.jsonl"

# Drive the public entry point — poll detects the stall is past the kill
# threshold and dispatches reap_stalled_slot.
poll_stall_detector

# Reap fired exactly once: kill_tree call recorded, envelope posted,
# label rotated, iter dir removed.
KILL_LINES="$(wc -l <"$TMP_ROOT/kill.calls" 2>/dev/null || echo 0)"
if [ "$KILL_LINES" -ge 1 ]; then ok "reap: sup_kill_tree invoked"; else bad "reap: sup_kill_tree never called"; fi

assert_contains "reap: gh repo view to resolve repo" "$(cat "$GH_CALLS")" 'repo view'
assert_contains "reap: posts envelope on #$ISSUE"    "$(cat "$GH_CALLS")" "issue comment $ISSUE"
assert_contains "reap: envelope body carries data-attempt-status=no-sentinel" \
  "$(cat "$GH_CALLS")" 'data-attempt-status="no-sentinel"'
assert_contains "reap: envelope summary names reason stall-reaped" \
  "$(cat "$GH_CALLS")" 'reason: stall-reaped'
assert_contains "reap: envelope notes section present" \
  "$(cat "$GH_CALLS")" 'data-section="notes"'
assert_contains "reap: envelope log section present" \
  "$(cat "$GH_CALLS")" 'data-section="log"'
assert_contains "reap: envelope quotes log tail" \
  "$(cat "$GH_CALLS")" 'stalled tool call'

EDITS="$(grep 'issue edit' "$GH_CALLS" || true)"
assert_contains "reap: removes running label"        "$EDITS" '--remove-label running'
assert_contains "reap: adds ready-for-agent label"   "$EDITS" '--add-label ready-for-agent'

# Iter dir cleaned up.
[ ! -d "$ITER_DIR" ] && ok "reap: iter dir removed" || bad "reap: iter dir still present"

# Slot bookkeeping reset so the health-check respawn loop picks it up.
assert_eq "reap: SLOT_PIDS cleared" "" "${SLOT_PIDS[0]}"
assert_eq "reap: SLOT_STALLED cleared" "0" "${SLOT_STALLED[0]}"
assert_eq "reap: SLOT_REAPED=1 guard set" "1" "${SLOT_REAPED[0]}"

# ---------- idempotency: re-poll is a no-op ----------

# Snapshot call counts.
PRE_GH="$(wc -l <"$GH_CALLS")"
PRE_KILL="$(wc -l <"$TMP_ROOT/kill.calls" 2>/dev/null || echo 0)"

# Drive poll again — slot is no longer flagged (we cleared SLOT_STALLED
# in the reap), so compute_stalled returns no and reap does not fire.
poll_stall_detector

POST_GH="$(wc -l <"$GH_CALLS")"
POST_KILL="$(wc -l <"$TMP_ROOT/kill.calls" 2>/dev/null || echo 0)"
assert_eq "reap: no extra gh calls on second poll"   "$PRE_GH" "$POST_GH"
assert_eq "reap: no extra kill calls on second poll" "$PRE_KILL" "$POST_KILL"

# ---------- no-issue path: worker died pre-claim ----------
# A reap with no afk.state.json must still kill, free the slot, and
# remove the iter dir, but post no envelope and rotate no labels.
WID2="wPREB"
ITER_DIR2="$TMP_ROOT/.red/tmp/workers/${WID2}/0-a1"
# First worker fully exited — its EXIT trap would have removed worker.pid and the
# worker dir; do the same here so only wPREB's worker.pid matches slot pid $$.
rm -rf "$TMP_ROOT/.red/tmp/workers/${WID}"
mkdir -p "$ITER_DIR2"
echo "$$" > "$(dirname "$ITER_DIR2")/worker.pid"
: > "$ITER_DIR2/afk.log"
: > "$ITER_DIR2/agent.log.jsonl"

SLOT_PIDS=("$$")
SLOT_STALL_SINCE_EPOCH=("$(( $(date +%s) - 120 ))")
SLOT_STALLED=(1)
SLOT_STALL_LOG=("$ITER_DIR2/agent.log.jsonl")
SLOT_REAPED=(0)

: >"$GH_CALLS"; : >"$TMP_ROOT/kill.calls"
touch -d "@$(( $(date +%s) - 120 ))" "$ITER_DIR2/agent.log.jsonl"

poll_stall_detector

NOISSUE_COMMENTS="$(grep -c 'issue comment' "$GH_CALLS" || true)"
assert_eq "no-issue reap: zero envelopes posted" "0" "$NOISSUE_COMMENTS"
NOISSUE_EDITS="$(grep -c 'issue edit' "$GH_CALLS" || true)"
assert_eq "no-issue reap: zero label edits"      "0" "$NOISSUE_EDITS"
[ ! -d "$ITER_DIR2" ] && ok "no-issue reap: iter dir removed" || bad "no-issue reap: iter dir still present"

echo
echo "summary: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
