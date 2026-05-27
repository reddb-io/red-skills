#!/usr/bin/env bash
# Fixture-based test for scripts/validate-agent-metadata.sh.
#
# Runs the validator against each fixture under
# scripts/fixtures/agent-metadata/{valid,invalid}/ and asserts the expected
# pass/fail outcome. Used by red-release.yml to catch malformed agent
# metadata before a release ships.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VALIDATOR="scripts/validate-agent-metadata.sh"
FIX_ROOT="scripts/fixtures/agent-metadata"

[ -x "$VALIDATOR" ] || {
  printf 'error: %s is not executable\n' "$VALIDATOR" >&2
  exit 1
}

fail_count=0
pass_count=0

expect_pass() {
  local label="$1"
  local plugin="$2"
  if "$VALIDATOR" --root "$(dirname "$plugin")" "$(basename "$plugin")" >/tmp/.agent-meta-out 2>&1; then
    printf 'PASS  valid/%s\n' "$label"
    pass_count=$((pass_count + 1))
  else
    printf 'FAIL  valid/%s — expected pass, got fail:\n' "$label" >&2
    sed 's/^/      /' /tmp/.agent-meta-out >&2
    fail_count=$((fail_count + 1))
  fi
}

expect_fail() {
  local label="$1"
  local plugin="$2"
  local needle="$3"
  if "$VALIDATOR" --root "$(dirname "$plugin")" "$(basename "$plugin")" >/tmp/.agent-meta-out 2>&1; then
    printf 'FAIL  invalid/%s — expected fail, got pass\n' "$label" >&2
    fail_count=$((fail_count + 1))
    return
  fi
  if ! grep -q "$needle" /tmp/.agent-meta-out; then
    printf 'FAIL  invalid/%s — failed but missing expected text %q\n' "$label" "$needle" >&2
    sed 's/^/      /' /tmp/.agent-meta-out >&2
    fail_count=$((fail_count + 1))
    return
  fi
  printf 'PASS  invalid/%s\n' "$label"
  pass_count=$((pass_count + 1))
}

expect_pass sample-plugin                "$FIX_ROOT/valid/sample-plugin"
expect_fail missing-description          "$FIX_ROOT/invalid/missing-description"          "non-empty 'description:'"
expect_fail no-frontmatter               "$FIX_ROOT/invalid/no-frontmatter"               "YAML frontmatter"
expect_fail codex-declares-agents        "$FIX_ROOT/invalid/codex-declares-agents"        "must not declare 'agents'"
expect_fail unknown-key                  "$FIX_ROOT/invalid/unknown-key"                  "unknown frontmatter key"
expect_fail empty-agents-dir             "$FIX_ROOT/invalid/empty-agents-dir"             "agents/ exists but is empty"

rm -f /tmp/.agent-meta-out

if [ "$fail_count" -ne 0 ]; then
  printf '\n%d failed, %d passed\n' "$fail_count" "$pass_count" >&2
  exit 1
fi
printf '\nall %d agent-metadata fixtures pass\n' "$pass_count"
