#!/usr/bin/env bash
# Static contract tests for the /approve merge credentials in red-hitl-card.yml.
#
# Regression guard for issue #2411: the act job merged with the default
# integration token, which cannot merge into protected main
# ("Resource not accessible by integration (mergePullRequest)"), so every
# /approve failed and approved issues looped back through the fleet.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

WORKFLOW=".github/workflows/red-hitl-card.yml"
failures=0

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  failures=$((failures + 1))
}

pass() {
  printf 'PASS: %s\n' "$*"
}

# The act job must authenticate with the org RELEASE_PAT, falling back to the
# default token only when the secret is absent.
if grep -qF 'GH_TOKEN: ${{ secrets.RELEASE_PAT || github.token }}' "$WORKFLOW"; then
  pass "act job prefers the RELEASE_PAT credential for /approve merges"
else
  fail "act job must set GH_TOKEN to secrets.RELEASE_PAT with a github.token fallback"
fi

# Merging a PR writes repository contents; the act job needs contents: write.
act_line="$(grep -nF '  act:' "$WORKFLOW" | head -n1 | cut -d: -f1 || true)"
if [ -z "$act_line" ]; then
  fail "missing act job in $WORKFLOW"
else
  if tail -n +"$act_line" "$WORKFLOW" | sed -n '1,20p' | grep -qF 'contents: write'; then
    pass "act job elevates to contents: write for the merge"
  else
    fail "act job must declare contents: write in its permissions block"
  fi
fi

# The workflow-level default must stay read-only so render/refresh keep the
# least-privilege token.
if grep -qF '  contents: read' "$WORKFLOW"; then
  pass "workflow-level default permissions remain contents: read"
else
  fail "workflow-level permissions must keep contents: read as the default"
fi

# No invented credential names: RELEASE_PAT is the only secret this repo uses.
if grep -q 'RED_RELEASE_TOKEN' "$WORKFLOW"; then
  fail "workflow references the nonexistent RED_RELEASE_TOKEN secret"
else
  pass "no invented credential names in the workflow"
fi

if [ "$failures" -gt 0 ]; then
  printf '\n%d hitl-card merge-token contract check(s) failed\n' "$failures" >&2
  exit 1
fi

printf '\nall hitl-card merge-token contract checks passed\n'
