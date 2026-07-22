#!/usr/bin/env bash
# Static contract test for the red-publish guard that catches dead reddb binary pointers.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

WORKFLOW=".github/workflows/red-publish.yml"
SCRIPT="scripts/verify-reddb-release-assets.mjs"
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

memory_manifest_line="$(line_of_step "Build memory runtime bundle + manifest")"
verify_line="$(line_of_step "Verify reddb release assets")"
tag_line="$(line_of_step "GitHub Release")"

assert_before "memory runtime manifest build" "$memory_manifest_line" "reddb asset verification" "$verify_line"
assert_before "reddb asset verification" "$verify_line" "tag/GitHub release" "$tag_line"

if grep -qF "node scripts/verify-reddb-release-assets.mjs dist/memory-runtime-manifest.json" "$WORKFLOW"; then
  pass "publish workflow verifies the generated memory runtime manifest"
else
  fail "publish workflow must verify dist/memory-runtime-manifest.json"
fi

if grep -qF 'method: "HEAD"' "$SCRIPT" &&
   grep -qF '`${entry.asset}.sha256`' "$SCRIPT" &&
   grep -qF 'process.exitCode = 1' "$SCRIPT"; then
  pass "reddb asset verifier HEAD-checks binaries and checksum sidecars"
else
  fail "reddb asset verifier must fail on missing binary or .sha256 asset"
fi

if (( failures > 0 )); then
  printf '\n%d failure(s)\n' "$failures" >&2
  exit 1
fi

printf '\nred-publish reddb asset contract ok\n'
