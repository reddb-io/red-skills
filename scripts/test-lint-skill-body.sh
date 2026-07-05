#!/usr/bin/env bash
# Fixture-based test for scripts/lint-skill-body.sh.
#
# Runs the report-only body lint against a compliant and a violating fixture
# tree under scripts/fixtures/skill-body/ and asserts the report content. The
# lint is report-only, so BOTH runs must exit 0 — the assertions are on the
# printed findings, not on the exit code.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LINT="scripts/lint-skill-body.sh"
FIX_ROOT="scripts/fixtures/skill-body"

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

# assert_grep LABEL FILE PATTERN — pass when PATTERN is present.
assert_grep() {
  local label="$1" file="$2" pat="$3"
  if grep -qF "$pat" "$file"; then check "$label" 1; else
    check "$label" 0
    printf '      expected to find: %s\n' "$pat" >&2
  fi
}

# assert_no_grep LABEL FILE PATTERN — pass when PATTERN is absent.
assert_no_grep() {
  local label="$1" file="$2" pat="$3"
  if grep -qF "$pat" "$file"; then
    check "$label" 0
    printf '      expected NOT to find: %s\n' "$pat" >&2
  else check "$label" 1; fi
}

# ---- Compliant tree: exits 0, zero findings, escapes exercised. ----
"$LINT" --root "$FIX_ROOT/compliant" >/tmp/.skill-body-compliant 2>&1
check "compliant/exit-0" "$([ "$?" -eq 0 ] && echo 1 || echo 0)"
assert_grep    "compliant/desc-clean"    /tmp/.skill-body-compliant "description discipline: 0 finding(s)"
assert_grep    "compliant/tags-clean"    /tmp/.skill-body-compliant "house tags:             0 finding(s)"
assert_grep    "compliant/orphans-clean" /tmp/.skill-body-compliant "orphaned bundled files: 0 finding(s)"
# Cross-skill template must NOT be flagged (referenced by a sibling SKILL.md).
assert_no_grep "compliant/cross-skill-escape" /tmp/.skill-body-compliant "shared-template.md"
# Drafts bucket is excluded — the draft skill and its orphan must NOT appear as
# findings (and, more broadly, a clean tree emits no FAIL lines at all).
assert_no_grep "compliant/no-findings"    /tmp/.skill-body-compliant "FAIL  "
assert_no_grep "compliant/drafts-skipped" /tmp/.skill-body-compliant "in-progress/draft"

# ---- Violating tree: exits 0, one finding per check. ----
"$LINT" --root "$FIX_ROOT/violating" >/tmp/.skill-body-violating 2>&1
check "violating/exit-0" "$([ "$?" -eq 0 ] && echo 1 || echo 0)"
assert_grep "violating/desc-usewhen"   /tmp/.skill-body-violating 'missing "Use when"'
assert_grep "violating/desc-overbudget" /tmp/.skill-body-violating "over budget (548 > 500)"
assert_grep "violating/house-tag"      /tmp/.skill-body-violating "has no <what-to-do> tag"
assert_grep "violating/orphan"         /tmp/.skill-body-violating "not referenced by any SKILL.md"
assert_grep "violating/desc-count"     /tmp/.skill-body-violating "description discipline: 1 finding(s)"
assert_grep "violating/tags-count"     /tmp/.skill-body-violating "house tags:             1 finding(s)"
assert_grep "violating/orphan-count"   /tmp/.skill-body-violating "orphaned bundled files: 1 finding(s)"

rm -f /tmp/.skill-body-compliant /tmp/.skill-body-violating

if [ "$fail_count" -ne 0 ]; then
  printf '\n%d failed, %d passed\n' "$fail_count" "$pass_count" >&2
  exit 1
fi
printf '\nall %d skill-body lint assertions pass\n' "$pass_count"
