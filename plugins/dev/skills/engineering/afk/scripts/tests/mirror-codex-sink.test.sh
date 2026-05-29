#!/usr/bin/env bash
# Smoke test for the Codex Task-mirror sink (issue #45, PRD #42, ADR 0003).
#
# The Task mirror is runner-specific: the state-reader (mirror_read_workers) and
# the reconciler (mirror_reconcile) from #43 are reused UNCHANGED — only the sink
# differs per runner. This suite exercises the Codex sink's two routes:
#
#   1. No native primitive (today's reality, the default) → fall back to the
#      monitor.sh dashboard and emit a one-line notice. No crash, no half-state
#      (zero native TaskCreate/TaskUpdate descriptors leak out).
#   2. A native primitive IS available (mock the capability probe) → apply the
#      reconciler's operations against it, i.e. emit the same call plan the Claude
#      sink consumes. Proves the reader + reconciler are reused, not reimplemented.

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

expect_contains() {
  local label="$1" needle="$2" haystack="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "PASS  $label"
    pass=$((pass + 1))
  else
    printf 'FAIL  %s\n      needle:  %q\n      in:      %q\n' "$label" "$needle" "$haystack"
    fail=$((fail + 1))
  fi
}

ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

# Same fixture helper shape as mirror.test.sh: a state file + (optional) live pid.
mk_worker() {
  local wid="$1" issue="$2" title="$3" stage="$4" pid="$5"
  # Nested layout (#252): workers/{wid}/{issue}-a1; liveness via state .pid.
  local dir="$ROOT/.red/tmp/workers/${wid}/${issue}-a1"
  mkdir -p "$dir"
  state_init "$dir/afk.state.json" worker_id="$wid" pid:="${pid/-/0}"
  state_write "$dir/afk.state.json" \
    current.number:="$issue" current.title="$title" \
    current.stage="$stage" current.started_at="2026-05-21T09:00:00-03:00"
}

LIVE=$$
mk_worker wAAAA 22 "extract state.sh" impl  "$LIVE"
mk_worker wBBBB 30 "second worker"     tests "$LIVE"

# ----------------------------------------------------------------------
# Route 1 — no native primitive (default probe) → monitor.sh fallback
# ----------------------------------------------------------------------

# Default capability: Codex ships no native task surface today.
if codex_native_task_available; then
  expect_eq "default: Codex reports no native task surface" "absent" "present"
else
  expect_eq "default: Codex reports no native task surface" "absent" "absent"
fi

out="$(mirror_sink_codex "$ROOT" 2>&1)"; rc=$?
expect_eq        "fallback: clean degrade, exits 0 (no crash)" "0" "$rc"
expect_contains  "fallback: emits the one-line notice"          "no native task surface" "$out"

notice_lines="$(printf '%s\n' "$out" | grep -c 'no native task surface')"
expect_eq "fallback: exactly one notice line" "1" "$notice_lines"

# No half-state: the fallback must not leak any native task call descriptors.
half="$(printf '%s\n' "$out" | grep -c '"call":"Task' || true)"
expect_eq "fallback: no native task calls emitted (no half-state)" "0" "$half"

# ----------------------------------------------------------------------
# Route 2 — native primitive available (mock) → apply the call plan
# ----------------------------------------------------------------------

# Override the single mockable boundary: pretend Codex grew a native surface.
codex_native_task_available() { return 0; }

plan_out="$(mirror_sink_codex "$ROOT" "")"; rc=$?
expect_eq "native: exits 0" "0" "$rc"

creates="$(printf '%s\n' "$plan_out" | jq -r 'select(.call=="TaskCreate") | .key' | sort)"
expect_eq "native: a TaskCreate per live worker" \
  "wAAAA:22
wBBBB:30" "$creates"

# The reader + reconciler are reused unchanged: the sink's native output is
# byte-for-byte the shared mirror_plan — only the sink (this wrapper) is new.
expect_eq "native: sink output == mirror_plan (only the sink is runner-specific)" \
  "$(mirror_plan "$ROOT" "")" "$plan_out"

# Restore the honest default for the remaining fallback checks.
codex_native_task_available() { return 1; }

# ----------------------------------------------------------------------
# Route 1 again — empty root, no workers → still a clean fallback
# ----------------------------------------------------------------------

EMPTY="$(mktemp -d)"
out_empty="$(mirror_sink_codex "$EMPTY" 2>&1)"; rc=$?
expect_eq       "fallback (empty root): exits 0" "0" "$rc"
expect_contains "fallback (empty root): still emits the notice" "no native task surface" "$out_empty"
half_empty="$(printf '%s\n' "$out_empty" | grep -c '"call":"Task' || true)"
expect_eq "fallback (empty root): no native task calls" "0" "$half_empty"
rm -rf "$EMPTY"

echo
echo "summary: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
