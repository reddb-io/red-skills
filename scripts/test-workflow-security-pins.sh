#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

failures=0

fail() {
  echo "FAIL: $*" >&2
  failures=$((failures + 1))
}

sha_re='^[0-9a-f]{40}$'

while IFS=$'\t' read -r file line action ref; do
  if [[ ! "$ref" =~ $sha_re ]]; then
    fail "$file:$line pins $action with '$ref' instead of a full commit SHA"
  fi
done < <(
  grep -RInE 'uses:[[:space:]]*(actions/(checkout|setup-node|github-script)|pnpm/action-setup|changesets/action)@' \
    .github/workflows .github/actions |
    sed -E 's/^([^:]+):([0-9]+):.*uses:[[:space:]]*([^[:space:]#]+)@([^[:space:]#]+).*/\1\t\2\t\3\t\4/'
)

while IFS=$'\t' read -r file line ref; do
  # afk-attempt is FIRST-PARTY (same repo), so a bare major tag (@v1) is safe:
  # the release signs+tests HEAD before force-moving v1 to it each cut, so @v1
  # always resolves to a green, just-released commit. Accept v1, v1.2.3, or a
  # full 40-char SHA. The general third-party `uses:` check below is UNCHANGED
  # and still requires a full commit SHA.
  if [[ ! "$ref" =~ ^(v[0-9]+(\.[0-9]+\.[0-9]+)?|[0-9a-f]{40})$ ]]; then
    fail "$file:$line pins afk-attempt with '$ref'; use a version/major tag or a full commit SHA"
  fi
done < <(
  grep -RInE 'uses:[[:space:]]*reddb-io/red-skills/\.github/actions/afk-attempt@' \
    .github/workflows |
    sed -E 's/^([^:]+):([0-9]+):.*afk-attempt@([^[:space:]#]+).*/\1\t\2\t\3/'
)

if grep -nE "authors\.push\('filipeforattini'\)|labelActors\.push\('filipeforattini'\)" .github/workflows/reusable-afk-attempt.yml; then
  fail "reusable-afk-attempt.yml still has a hardcoded maintainer fallback"
fi

grep -qF 'ref: ${{ github.event.pull_request.base.sha }}' .github/workflows/red-pr-review.yml ||
  fail "red-pr-review.yml must checkout the base PR SHA before running the launcher"

grep -qF 'ref: ${{ github.event.pull_request.base.sha || github.event.repository.default_branch }}' .github/workflows/red-comment-respond.yml ||
  fail "red-comment-respond.yml must checkout a base-repo ref before running the launcher"

grep -qF 'ref: ${{ github.event.pull_request.base.sha }}' .github/workflows/archive/red-hitl-card.yml ||
  fail "red-hitl-card.yml must checkout the base PR SHA before running the launcher"

for workflow in \
  .github/workflows/red-workspace-ci.yml \
  .github/workflows/red-rsp-benchmark-ci.yml; do
  grep -qF 'https://api.github.com/repos/reddb-io/toon/contents/install.sh?ref=${TQ_VERSION}' "$workflow" ||
    fail "$workflow must fetch the pinned tq installer through the GitHub API"
  grep -qF 'Authorization: Bearer ${GH_TOKEN}' "$workflow" ||
    fail "$workflow must authenticate the pinned tq installer fetch"
  grep -qF 'GH_TOKEN: ${{ github.token }}' "$workflow" ||
    fail "$workflow must source tq installer authentication from github.token"
  if grep -qF 'raw.githubusercontent.com/reddb-io/toon/${TQ_VERSION}/install.sh' "$workflow"; then
    fail "$workflow must not fetch the pinned tq installer anonymously"
  fi
done

if (( failures > 0 )); then
  exit 1
fi

echo "workflow security pins ok"
