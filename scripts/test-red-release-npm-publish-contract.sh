#!/usr/bin/env bash
# Static contract tests for the npm publish ordering in red-release.yml.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

WORKFLOW=".github/workflows/red-release.yml"
failures=0

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  failures=$((failures + 1))
}

pass() {
  printf 'PASS: %s\n' "$*"
}

line_of_step() {
  local step="$1"
  local line
  line="$(grep -nF -- "- name: $step" "$WORKFLOW" | head -n1 | cut -d: -f1 || true)"
  if [ -z "$line" ]; then
    fail "missing release workflow step: $step"
    printf '0\n'
  else
    printf '%s\n' "$line"
  fi
}

assert_before() {
  local left_name="$1" left_line="$2" right_name="$3" right_line="$4"
  if [ "$left_line" -gt 0 ] && [ "$right_line" -gt 0 ] && [ "$left_line" -lt "$right_line" ]; then
    pass "$left_name runs before $right_name"
  else
    fail "$left_name must run before $right_name"
  fi
}

pack_line="$(line_of_step "Pack npm package + producer/consumer contract check")"
publish_line="$(line_of_step "Publish to npm")"
smoke_line="$(line_of_step "Smoke published npm package from registry")"
stamp_line="$(line_of_step "Sync plugin manifest versions")"
tag_line="$(line_of_step "Tag + GitHub Release")"

assert_before "pack/contract check" "$pack_line" "publish" "$publish_line"
assert_before "publish" "$publish_line" "registry smoke" "$smoke_line"
assert_before "registry smoke" "$smoke_line" "manifest stamping" "$stamp_line"
assert_before "manifest stamping" "$stamp_line" "tag/GitHub release" "$tag_line"

if grep -qF '::error::NPM_TOKEN secret absent' "$WORKFLOW"; then
  pass "missing NPM_TOKEN is reported as an error"
else
  fail "missing NPM_TOKEN must emit ::error::"
fi

if grep -qF 'skipping npm publish' "$WORKFLOW"; then
  fail "release workflow still skips npm publish when NPM_TOKEN is absent"
else
  pass "missing NPM_TOKEN does not skip publish"
fi

if grep -qF 'npx -y -p "@reddb-io/red-skills@${version}" red-skills-dev --version' "$WORKFLOW"; then
  pass "registry smoke uses npx against the published package version"
else
  fail "registry smoke must run the real client via npx from the npm registry"
fi

if grep -qF 'package/dist/code-nav.bundle.min.mjs' "$WORKFLOW" &&
   grep -qF 'npm tarball missing $expected' "$WORKFLOW"; then
  pass "pack contract checks the code-nav bundle is in the npm tarball"
else
  fail "pack contract must fail when code-nav is missing from the npm tarball"
fi

if grep -qF 'registry smoke returned' "$WORKFLOW" &&
   grep -qF 'dev ${version} ' "$WORKFLOW"; then
  pass "registry smoke verifies the reported release version"
else
  fail "registry smoke must fail when --version does not report the release version"
fi

if grep -qF 'already on the registry — publish already complete' "$WORKFLOW"; then
  pass "publish is idempotent so a re-run can resume the release tail"
else
  fail "publish must no-op when the version is already on the registry (resumable release tail)"
fi

if grep -qF 'for attempt in 1 2 3 4 5 6 7 8 9 10' "$WORKFLOW" &&
   grep -qF 'sleep $((attempt * 15))' "$WORKFLOW"; then
  pass "registry smoke budget covers multi-minute registry propagation lag"
else
  fail "registry smoke must retry across a multi-minute propagation window (10 attempts, attempt*15s backoff)"
fi

if (( failures > 0 )); then
  printf '\n%d failure(s)\n' "$failures" >&2
  exit 1
fi

printf '\nred-release npm publish contract ok\n'
