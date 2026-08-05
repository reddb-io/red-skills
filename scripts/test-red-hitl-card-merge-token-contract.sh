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

WORKFLOW=".github/workflows/archive/red-hitl-card.yml"
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

# Automation comments must be rejected at the event boundary, before the
# launcher can parse a bot refusal or card receipt as a fresh human directive.
if grep -qF "github.event.comment.user.type == 'User'" "$WORKFLOW"; then
  pass "act job accepts only GitHub User-authored comments"
else
  fail "act job must reject Bot-authored comments in its job condition"
fi

if grep -qF 'contains(fromJSON('\''["filipeforattini"]'\''), github.event.comment.user.login)' "$WORKFLOW"; then
  pass "act job admits only the explicit human login allowlist"
else
  fail "act job must apply the explicit human login allowlist before launch"
fi

if grep -qF 'COMMENT_AUTHOR_TYPE: ${{ github.event.comment.user.type }}' "$WORKFLOW" &&
   grep -qF -- '--author-type "$COMMENT_AUTHOR_TYPE"' "$WORKFLOW"; then
  pass "comment author type is forwarded to the runtime guard"
else
  fail "act job must forward comment.user.type as --author-type"
fi

if grep -qF 'HITL_CARD_ALLOWED_AUTHORS: filipeforattini' "$WORKFLOW" &&
   grep -qF 'HITL_CARD_RECEIPT_IDENTITIES: filipeforattini:User,github-actions[bot]:Bot' "$WORKFLOW" &&
   grep -qF -- '--allowed-authors "$HITL_CARD_ALLOWED_AUTHORS"' "$WORKFLOW" &&
   grep -qF -- '--receipt-identities "$HITL_CARD_RECEIPT_IDENTITIES"' "$WORKFLOW"; then
  pass "runtime receives explicit human and card-receipt identities"
else
  fail "act job must forward explicit human and card-receipt identities"
fi

# Serialize actions for one issue so each invocation observes the prior action
# receipt before applying the per-window cap.
if grep -qF 'group: red-hitl-card-act-${{ github.repository }}-${{ github.event.issue.number }}' "$WORKFLOW" &&
   grep -qF 'cancel-in-progress: false' "$WORKFLOW"; then
  pass "act job serializes commands per issue"
else
  fail "act job must declare a per-issue non-cancelling concurrency group"
fi

if [ "$failures" -gt 0 ]; then
  printf '\n%d hitl-card merge-token contract check(s) failed\n' "$failures" >&2
  exit 1
fi

printf '\nall hitl-card merge-token contract checks passed\n'
