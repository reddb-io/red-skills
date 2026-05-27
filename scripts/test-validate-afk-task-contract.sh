#!/usr/bin/env bash
# Fixture-based test for scripts/validate-afk-task-contract.sh.
#
# Runs the validator against each fixture under
# .red/contracts/fixtures/afk-task/{valid,invalid}/ and asserts the expected
# pass/fail outcome. Used by red-release.yml to catch contract drift.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VALIDATOR="scripts/validate-afk-task-contract.sh"
FIX_ROOT=".red/contracts/fixtures/afk-task"
OUT=/tmp/.afk-task-contract-out

[ -x "$VALIDATOR" ] || {
  printf 'error: %s is not executable\n' "$VALIDATOR" >&2
  exit 1
}

fail_count=0
pass_count=0

expect_pass() {
  local label="$1"
  local file="$FIX_ROOT/valid/$1"
  if "$VALIDATOR" "$file" >"$OUT" 2>&1; then
    printf 'PASS  valid/%s\n' "$label"
    pass_count=$((pass_count + 1))
  else
    printf 'FAIL  valid/%s — expected pass, got fail:\n' "$label" >&2
    sed 's/^/      /' "$OUT" >&2
    fail_count=$((fail_count + 1))
  fi
}

expect_fail() {
  local label="$1"
  local needle="$2"
  local file="$FIX_ROOT/invalid/$1"
  if "$VALIDATOR" "$file" >"$OUT" 2>&1; then
    printf 'FAIL  invalid/%s — expected fail, got pass\n' "$label" >&2
    fail_count=$((fail_count + 1))
    return
  fi
  if ! grep -q "$needle" "$OUT"; then
    printf 'FAIL  invalid/%s — failed but missing expected text %q\n' "$label" "$needle" >&2
    sed 's/^/      /' "$OUT" >&2
    fail_count=$((fail_count + 1))
    return
  fi
  printf 'PASS  invalid/%s\n' "$label"
  pass_count=$((pass_count + 1))
}

expect_pass completed-execute.json
expect_pass blocked-execute.json
expect_pass escalation-verify.json

expect_fail malformed-json.json   "malformed JSON"
expect_fail missing-fields.json   "missing required field"
expect_fail hollow-success.json   "hollow success"

rm -f "$OUT"

if [ "$fail_count" -ne 0 ]; then
  printf '\n%d failed, %d passed\n' "$fail_count" "$pass_count" >&2
  exit 1
fi
printf '\nall %d afk-task contract fixtures pass\n' "$pass_count"
