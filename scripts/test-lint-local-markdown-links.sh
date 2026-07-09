#!/usr/bin/env bash
# Fixture-based test for scripts/lint-local-markdown-links.mjs.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LINT="scripts/lint-local-markdown-links.mjs"
FIX_ROOT="scripts/fixtures/local-markdown-links"

[ -x "$LINT" ] || {
  printf 'error: %s is not executable\n' "$LINT" >&2
  exit 1
}

fail_count=0
pass_count=0

check() {
  local label="$1"
  local cond="$2"
  if [ "$cond" = "1" ]; then
    printf 'PASS  %s\n' "$label"
    pass_count=$((pass_count + 1))
  else
    printf 'FAIL  %s\n' "$label" >&2
    fail_count=$((fail_count + 1))
  fi
}

assert_grep() {
  local label="$1" file="$2" pat="$3"
  if grep -qF "$pat" "$file"; then check "$label" 1; else
    check "$label" 0
    printf '      expected to find: %s\n' "$pat" >&2
  fi
}

"$LINT" --root "$FIX_ROOT/compliant" >/tmp/.local-md-links-compliant 2>&1
check "compliant/exit-0" "$([ "$?" -eq 0 ] && echo 1 || echo 0)"
assert_grep "compliant/clean" /tmp/.local-md-links-compliant "0 broken local link(s)"

"$LINT" --root "$FIX_ROOT/violating" >/tmp/.local-md-links-violating 2>&1
check "violating/exit-nonzero" "$([ "$?" -ne 0 ] && echo 1 || echo 0)"
assert_grep "violating/reports-broken-target" /tmp/.local-md-links-violating "missing.md"
assert_grep "violating/reports-source-line" /tmp/.local-md-links-violating "plugins/demo/skills/bad/SKILL.md:3"

rm -f /tmp/.local-md-links-compliant /tmp/.local-md-links-violating

if [ "$fail_count" -ne 0 ]; then
  printf '\n%d failed, %d passed\n' "$fail_count" "$pass_count" >&2
  exit 1
fi
printf '\nall %d local markdown link assertions pass\n' "$pass_count"
