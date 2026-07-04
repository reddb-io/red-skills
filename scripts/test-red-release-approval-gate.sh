#!/usr/bin/env bash
# Contract test for the red-release publishing approval gate.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

WORKFLOW=".github/workflows/red-release.yml"
README="README.md"
ENVIRONMENT_NAME="red-release"

fail_count=0
pass_count=0

pass() { printf 'PASS  %s\n' "$1"; pass_count=$((pass_count + 1)); }
fail() { printf 'FAIL  %s\n' "$1" >&2; fail_count=$((fail_count + 1)); }

assert_grep() {
  local label="$1" pattern="$2" file="$3"
  if grep -qE "$pattern" "$file"; then
    pass "$label"
  else
    fail "$label - pattern not found: $pattern in $file"
  fi
}

assert_release_job_environment() {
  local block
  block="$(awk '
    /^  release:/ { in_release = 1 }
    in_release && /^  [A-Za-z0-9_-]+:/ && !/^  release:/ { exit }
    in_release { print }
  ' "$WORKFLOW")"

  if grep -qE '^    environment:' <<<"$block" &&
     grep -qE "^[[:space:]]+name: ${ENVIRONMENT_NAME}$" <<<"$block"; then
    pass "release job uses ${ENVIRONMENT_NAME} environment"
  else
    fail "release job does not use ${ENVIRONMENT_NAME} environment"
  fi
}

assert_release_job_environment
assert_grep "README documents approval requirement" \
  "environment.*${ENVIRONMENT_NAME}.*approval|required reviewers" \
  "$README"

printf '\n%d passed, %d failed\n' "$pass_count" "$fail_count"
[ "$fail_count" -eq 0 ]
