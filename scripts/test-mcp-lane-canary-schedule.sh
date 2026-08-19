#!/usr/bin/env bash
# Contract for the MCP lane canary's DELIVERY (#2844).
#
# The canary's assertions were never the gap — its delivery was. It existed as a
# command someone had to remember to run, which is how a whole subsystem reached
# a closed Spec with no running process and produced no signal at all. This
# script pins the two facts that keep it a signal:
#
#   1. It runs without a human: a schedule, plus the lane's own pushes.
#   2. It never blocks unrelated work: no `pull_request` trigger, because a probe
#      that reddens merges on a transient becomes one people route around.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

WORKFLOW=".github/workflows/red-mcp-lane-canary.yml"
PACKAGE="apps/plugin-dev/package.json"
failures=0

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  failures=$((failures + 1))
}

pass() {
  printf 'PASS: %s\n' "$1"
}

if [ ! -f "$WORKFLOW" ]; then
  fail "$WORKFLOW is missing — the canary is back to manual invocation only"
  exit 1
fi
pass "$WORKFLOW exists"

# 1) Fires without a human.
if grep -qE '^[[:space:]]+- cron:' "$WORKFLOW" && grep -qE '^[[:space:]]*schedule:' "$WORKFLOW"; then
  pass "the canary runs on a schedule"
else
  fail "$WORKFLOW declares no schedule: cron — nobody would be told about an inert lane"
fi

grep -qE '^[[:space:]]*workflow_dispatch:' "$WORKFLOW" ||
  fail "$WORKFLOW has no workflow_dispatch — an operator cannot re-run the probe on demand"

# 2) Never a merge gate.
if grep -qE '^[[:space:]]*pull_request(_target)?:' "$WORKFLOW"; then
  fail "$WORKFLOW triggers on pull_request — the canary must not gate unrelated merges"
else
  pass "the canary is not wired as a pull-request gate"
fi

# Least privilege, same posture as every other workflow.
grep -qE '^permissions:[[:space:]]*$|^permissions:[[:space:]]*\{' "$WORKFLOW" ||
  fail "$WORKFLOW has no explicit top-level permissions: block"

# 3) It actually runs the canary, through the one script operators run too.
grep -qF 'pnpm -C apps/plugin-dev test:canary' "$WORKFLOW" ||
  fail "$WORKFLOW does not run 'pnpm -C apps/plugin-dev test:canary'"

CANARY_SCRIPT="$(node -e '
  const pkg = require("./apps/plugin-dev/package.json");
  process.stdout.write(pkg.scripts?.["test:canary"] ?? "");
')"
if [ -z "$CANARY_SCRIPT" ]; then
  fail "$PACKAGE declares no test:canary script"
else
  pass "$PACKAGE declares test:canary"
  for suite in tests/mcp-lane-canary.test.ts tests/mcp-lane-canary-e2e.test.ts; do
    case "$CANARY_SCRIPT" in
      *"$suite"*) pass "test:canary runs $suite" ;;
      # The e2e suite is the one that walks the SHIPPED bundle against a live
      # daemon and proves two broken lanes go red; dropping it would leave a
      # green that means nothing.
      *) fail "test:canary does not run $suite" ;;
    esac
  done
fi

if (( failures > 0 )); then
  exit 1
fi

echo "mcp lane canary schedule ok"
