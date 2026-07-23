#!/usr/bin/env bash
# Fork-posture gate (issue #2603): assert the GitHub Actions surface stays safe
# against fork-reachable events. Mechanical, dependency-free, runs in CI.
#
#   1. NO workflow uses `pull_request_target` (it runs privileged code against a
#      fork head with secrets in scope).
#   2. EVERY workflow declares an explicit top-level `permissions:` block, so no
#      fork-reachable workflow rides the default token scope.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

failures=0
fail() {
  echo "FAIL: $*" >&2
  failures=$((failures + 1))
}

# 1) No pull_request_target anywhere.
if grep -RInE '^[[:space:]]*pull_request_target[[:space:]]*:' .github/workflows; then
  fail "pull_request_target is forbidden — it exposes secrets to fork head code"
fi

# 2) Every workflow file carries an explicit top-level permissions: block.
for wf in .github/workflows/*.yml; do
  # A top-level key sits at column 0 (`permissions:`), not nested under a job.
  if ! grep -qE '^permissions:[[:space:]]*$|^permissions:[[:space:]]*\{' "$wf"; then
    fail "$wf has no explicit top-level permissions: block (least-privilege required)"
  fi
done

if (( failures > 0 )); then
  exit 1
fi

echo "workflow fork posture ok"
