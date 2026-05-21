#!/usr/bin/env bash
# Tests for plugins/.../afk/scripts/lib/mirror.sh (issue #43).
#
# Three families, matching the three layers of the Task mirror:
#   1. state-reader (mirror_read_workers) — live vs dead pid, missing/partial
#      state, multiple workers, idle (no current issue) workers omitted.
#   2. mirror-reconciler (mirror_reconcile) — cold reconcile = all creates,
#      stage advance = update, terminal = complete, idempotent re-run = no-op,
#      worker gone = complete/drop.
#   3. sink mapping (mirror_plan) — operation list maps to expected harness
#      calls (TaskCreate / TaskUpdate) at the mockable boundary.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPTS="$(dirname "$HERE")"
LIB="$SCRIPTS/lib/mirror.sh"

# shellcheck source=../lib/mirror.sh
source "$LIB"

pass=0
fail=0

expect_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "PASS  $label"
    pass=$((pass + 1))
  else
    printf 'FAIL  %s\n      expected: %q\n      actual:   %q\n' "$label" "$expected" "$actual"
    fail=$((fail + 1))
  fi
}

ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

# Build an iteration dir under $ROOT/.red/tmp with a state file and (optionally)
# a live pid file. Usage: mk_worker <wid> <issue> <title> <stage> <pid|->
mk_worker() {
  local wid="$1" issue="$2" title="$3" stage="$4" pid="$5"
  local dir="$ROOT/.red/tmp/work-${wid}-i${issue}"
  mkdir -p "$dir"
  state_init "$dir/afk.state.json" worker_id="$wid" pid:="${pid/-/0}"
  state_write "$dir/afk.state.json" \
    current.number:="$issue" current.title="$title" \
    current.stage="$stage" current.started_at="2026-05-21T09:00:00-03:00"
  if [[ "$pid" != "-" ]]; then
    printf '%s' "$pid" > "$dir/afk.pid"
  fi
}

# A live pid for "running" workers: this test shell is guaranteed alive.
LIVE=$$

# ----------------------------------------------------------------------
# Family 1 — state-reader
# ----------------------------------------------------------------------

mk_worker wAAAA 22 "extract state.sh" impl "$LIVE"     # live, running
mk_worker wBBBB 30 "second worker"     tests "$LIVE"   # live, running
mk_worker wCCCC 31 "crashed worker"    impl 999999     # pid dead → gone
mk_worker wDDDD 0  ""                   setup "$LIVE"   # no real issue → omitted

# wDDDD has current.number 0; fix it to be a truly-absent current to test idle
state_write "$ROOT/.red/tmp/work-wDDDD-i0/afk.state.json" current:=null

readers="$(mirror_read_workers "$ROOT" | jq -c '.' | sort)"

count="$(printf '%s\n' "$readers" | grep -c .)"
expect_eq "reader: 3 records (idle worker omitted)" "3" "$count"

a="$(printf '%s\n' "$readers" | jq -c 'select(.worker_id=="wAAAA")')"
expect_eq "reader: wAAAA status running" "running" "$(jq -r '.status' <<<"$a")"
expect_eq "reader: wAAAA stage impl"     "impl"     "$(jq -r '.stage' <<<"$a")"
expect_eq "reader: wAAAA issue 22"       "22"       "$(jq -r '.issue' <<<"$a")"
expect_eq "reader: wAAAA title"          "extract state.sh" "$(jq -r '.title' <<<"$a")"

c="$(printf '%s\n' "$readers" | jq -c 'select(.worker_id=="wCCCC")')"
expect_eq "reader: wCCCC dead pid → gone" "gone" "$(jq -r '.status' <<<"$c")"

d="$(printf '%s\n' "$readers" | jq -c 'select(.worker_id=="wDDDD")')"
expect_eq "reader: idle worker (current null) omitted" "" "$d"

# Missing / partial state file: a work dir with no state file → no record, no crash.
mkdir -p "$ROOT/.red/tmp/work-wEEEE-i9"
printf '%s' "$LIVE" > "$ROOT/.red/tmp/work-wEEEE-i9/afk.pid"
count2="$(mirror_read_workers "$ROOT" | grep -c .)"
expect_eq "reader: dir without state file ignored" "3" "$count2"

# Empty root → empty output, exit clean.
EMPTY="$(mktemp -d)"
out_empty="$(mirror_read_workers "$EMPTY"; echo "rc=$?")"
expect_eq "reader: empty root yields nothing, rc 0" "rc=0" "$out_empty"
rm -rf "$EMPTY"

# ----------------------------------------------------------------------
# Family 2 — reconciler
# ----------------------------------------------------------------------

W22='{"worker_id":"wAAAA","issue":22,"title":"t","stage":"impl","started_at":"x","status":"running"}'
W30='{"worker_id":"wBBBB","issue":30,"title":"u","stage":"tests","started_at":"x","status":"running"}'

# Cold reconcile: nothing tracked → all creates.
cold="$(mirror_reconcile "$W22"$'\n'"$W30" "")"
expect_eq "reconcile: cold = 2 ops"       "2" "$(printf '%s\n' "$cold" | grep -c .)"
expect_eq "reconcile: cold all create"    "create
create" "$(printf '%s\n' "$cold" | jq -r '.op' | sort)"

# Stage advance: wAAAA tracked at impl, now reports tests → one update.
adv="$(mirror_reconcile \
  '{"worker_id":"wAAAA","issue":22,"title":"t","stage":"tests","started_at":"x","status":"running"}' \
  '{"key":"wAAAA:22","stage":"impl"}')"
expect_eq "reconcile: stage advance = update" "update" "$(jq -r '.op' <<<"$adv")"
expect_eq "reconcile: update carries new stage" "tests" "$(jq -r '.stage' <<<"$adv")"

# Idempotent re-run: tracked stage == desired stage → no ops.
noop="$(mirror_reconcile "$W22" '{"key":"wAAAA:22","stage":"impl"}')"
expect_eq "reconcile: idempotent re-run = no-op" "" "$noop"

# Terminal status reported by reader (gone) for a tracked worker → complete.
term="$(mirror_reconcile \
  '{"worker_id":"wAAAA","issue":22,"title":"t","stage":"impl","started_at":"x","status":"gone"}' \
  '{"key":"wAAAA:22","stage":"impl"}')"
expect_eq "reconcile: terminal = complete" "complete" "$(jq -r '.op' <<<"$term")"
expect_eq "reconcile: gone terminal → completed" "completed" "$(jq -r '.result' <<<"$term")"

# Blocked terminal → complete with failed result.
blk="$(mirror_reconcile \
  '{"worker_id":"wAAAA","issue":22,"title":"t","stage":"impl","started_at":"x","status":"blocked"}' \
  '{"key":"wAAAA:22","stage":"impl"}')"
expect_eq "reconcile: blocked terminal → failed" "failed" "$(jq -r '.result' <<<"$blk")"

# Worker gone: tracked but absent from desired entirely → complete/drop.
drop="$(mirror_reconcile "$W30" '{"key":"wAAAA:22","stage":"impl"}')"
ops_sorted="$(printf '%s\n' "$drop" | jq -r '"\(.op) \(.key)"' | sort)"
expect_eq "reconcile: missing worker dropped + new created" \
  "complete wAAAA:22
create wBBBB:30" "$ops_sorted"

# Terminal status for a worker never tracked → ignored (no op).
untracked_term="$(mirror_reconcile \
  '{"worker_id":"wZZZZ","issue":99,"title":"z","stage":"impl","started_at":"x","status":"gone"}' "")"
expect_eq "reconcile: untracked terminal ignored" "" "$untracked_term"

# ----------------------------------------------------------------------
# Family 3 — sink mapping (mockable boundary)
# ----------------------------------------------------------------------

# Cold plan over the live fixtures: wAAAA + wBBBB create, wCCCC completes
# (gone but only if tracked — untracked gone is ignored, so a cold plan over
# the reader sees wCCCC as untracked-terminal → no call).
plan_cold="$(mirror_plan "$ROOT" "")"
calls="$(printf '%s\n' "$plan_cold" | jq -r '.call' | sort)"
expect_eq "plan: cold = 2 TaskCreate (gone-but-untracked ignored)" \
  "TaskCreate
TaskCreate" "$calls"

create_a="$(printf '%s\n' "$plan_cold" | jq -c 'select(.key=="wAAAA:22")')"
expect_eq "plan: create title carries #issue + worker" \
  "#22 wAAAA — extract state.sh" "$(jq -r '.title' <<<"$create_a")"
expect_eq "plan: create description carries stage" \
  "stage: impl" "$(jq -r '.description' <<<"$create_a")"
expect_eq "plan: create state in_progress" \
  "in_progress" "$(jq -r '.state' <<<"$create_a")"

# Plan with wAAAA + wBBBB already tracked at their current stages: wCCCC is now
# tracked too → its gone status maps to a TaskUpdate completed.
tracked_all='{"key":"wAAAA:22","stage":"impl"}
{"key":"wBBBB:30","stage":"tests"}
{"key":"wCCCC:31","stage":"impl"}'
plan_steady="$(mirror_plan "$ROOT" "$tracked_all")"
ccomplete="$(printf '%s\n' "$plan_steady" | jq -c 'select(.key=="wCCCC:31")')"
expect_eq "plan: tracked gone worker → TaskUpdate" "TaskUpdate" "$(jq -r '.call' <<<"$ccomplete")"
expect_eq "plan: tracked gone worker → completed"  "completed"  "$(jq -r '.state' <<<"$ccomplete")"
# wAAAA / wBBBB unchanged → no calls for them.
steady_keys="$(printf '%s\n' "$plan_steady" | jq -r 'select(.key=="wAAAA:22" or .key=="wBBBB:30") | .key')"
expect_eq "plan: unchanged running workers emit no call" "" "$steady_keys"

# Read-only invariant: the reader/plan must never mutate the state files.
before="$(cat "$ROOT/.red/tmp/work-wAAAA-i22/afk.state.json")"
mirror_plan "$ROOT" "$tracked_all" >/dev/null
after="$(cat "$ROOT/.red/tmp/work-wAAAA-i22/afk.state.json")"
expect_eq "plan: state file untouched (read-only invariant)" "$before" "$after"

# ----------------------------------------------------------------------
# Family 4 — re-hydration on session reopen (issue #44)
# ----------------------------------------------------------------------
#
# A native task dies with the Claude Code session; the nohup worker does not.
# On reopen, TaskList returns no mirror-owned tasks, so the first monitor tick
# runs mirror_plan with an EMPTY tracked set — re-hydration is the reconciler
# running cold. No new code path: this family verifies that contract over the
# live fixtures (wAAAA + wBBBB live, wCCCC dead/gone, wDDDD idle, wEEEE no state).

# Criterion 1 — reopen rebuilds the per-worker tasks with no operator action:
# an empty tracked set yields a TaskCreate for every live worker.
rehydrate="$(mirror_plan "$ROOT" "")"
rehydrate_creates="$(printf '%s\n' "$rehydrate" | jq -r 'select(.call=="TaskCreate") | .key' | sort)"
expect_eq "rehydrate: reopen recreates each live worker task" \
  "wAAAA:22
wBBBB:30" "$rehydrate_creates"

# Criterion 2 — only live-pid workers re-hydrate; the dead worker (wCCCC, pid
# 999999) is untracked on a cold tick, so its terminal status emits no call:
# no ghost task.
rehydrate_ghost="$(printf '%s\n' "$rehydrate" | jq -c 'select(.key=="wCCCC:31")')"
expect_eq "rehydrate: dead worker produces no ghost task" "" "$rehydrate_ghost"

# Criterion 3 — idempotent. Build the tracked set from what reopen created
# (key + stage), then run the next tick: no worker advanced, so zero ops — no
# duplicate tasks for the same (worker, issue).
tracked_after_reopen="$(printf '%s\n' "$rehydrate" \
  | jq -c 'select(.call=="TaskCreate") | {key, stage: (.description | sub("^stage: "; ""))}')"
second_tick="$(mirror_plan "$ROOT" "$tracked_after_reopen")"
expect_eq "rehydrate: second tick is idempotent (no duplicates)" "" "$second_tick"

echo
echo "summary: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
