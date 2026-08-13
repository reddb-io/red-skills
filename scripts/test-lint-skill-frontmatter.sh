#!/usr/bin/env bash
# Fixture-based test for scripts/lint-skill-frontmatter.sh.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LINT="scripts/lint-skill-frontmatter.sh"
FIX_ROOT="scripts/fixtures/skill-frontmatter"

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

assert_no_grep() {
  local label="$1" file="$2" pat="$3"
  if grep -qF "$pat" "$file"; then
    check "$label" 0
    printf '      expected NOT to find: %s\n' "$pat" >&2
  else check "$label" 1; fi
}

"$LINT" --root "$FIX_ROOT/compliant" >/tmp/.skill-frontmatter-compliant 2>&1
check "compliant/exit-0" "$([ "$?" -eq 0 ] && echo 1 || echo 0)"
assert_grep "compliant/summary" /tmp/.skill-frontmatter-compliant "passed marketplace frontmatter audit"
assert_no_grep "compliant/no-failures" /tmp/.skill-frontmatter-compliant "FAIL  "

"$LINT" --root "$FIX_ROOT/violating" >/tmp/.skill-frontmatter-violating 2>&1
check "violating/exit-1" "$([ "$?" -eq 1 ] && echo 1 || echo 0)"
assert_grep "violating/name" /tmp/.skill-frontmatter-violating "bad-name/SKILL.md"
assert_grep "violating/name-rule" /tmp/.skill-frontmatter-violating "name-matches-directory"
assert_grep "violating/description" /tmp/.skill-frontmatter-violating "empty-description/SKILL.md"
assert_grep "violating/description-rule" /tmp/.skill-frontmatter-violating "description-non-empty"
assert_grep "violating/wildcard" /tmp/.skill-frontmatter-violating "wildcard-tools/SKILL.md"
assert_grep "violating/wildcard-rule" /tmp/.skill-frontmatter-violating "no-wildcard-tool-grant"
assert_grep "violating/paths" /tmp/.skill-frontmatter-violating "malformed-paths/SKILL.md"
assert_grep "violating/paths-rule" /tmp/.skill-frontmatter-violating "paths-globs-valid"

rm -f /tmp/.skill-frontmatter-compliant /tmp/.skill-frontmatter-violating

if [ "$fail_count" -ne 0 ]; then
  printf '\n%d failed, %d passed\n' "$fail_count" "$pass_count" >&2
  exit 1
fi
printf '\nall %d skill-frontmatter lint assertions pass\n' "$pass_count"
