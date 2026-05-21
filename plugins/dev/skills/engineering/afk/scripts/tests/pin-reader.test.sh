#!/usr/bin/env bash
# Tests for plugins/.../afk/scripts/lib/pin-reader.sh (issue #64).
#
# Covers the three behaviours the acceptance criteria name:
#   - parse: pull a canonical `branch:` line out of a body (and reject prose);
#   - PRD→issue inheritance: an issue with no line falls back to its PRD's line,
#     but its own line wins when present;
#   - default main: no pin anywhere resolves to `main`.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPTS="$(dirname "$HERE")"
LIB="$SCRIPTS/lib/pin-reader.sh"

# shellcheck source=../lib/pin-reader.sh
source "$LIB"

pass=0
fail=0

expect_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "PASS  $label"
    pass=$((pass + 1))
  else
    printf 'FAIL  %s\n      expected: %q\n      actual:   %q\n' "$label" "$expected" "$actual"
    fail=$((fail + 1))
  fi
}

expect_ok() {
  local label="$1"; shift
  if "$@"; then
    echo "PASS  $label"
    pass=$((pass + 1))
  else
    echo "FAIL  $label (command failed: $*)"
    fail=$((fail + 1))
  fi
}

expect_fail() {
  local label="$1"; shift
  if "$@"; then
    echo "FAIL  $label (command unexpectedly succeeded: $*)"
    fail=$((fail + 1))
  else
    echo "PASS  $label"
    pass=$((pass + 1))
  fi
}

# ---------- pin_parse_branch ----------

body_simple=$'## What to build\nbranch: feature/login\nmore text'
expect_eq "parse: bare branch line" "feature/login" "$(pin_parse_branch "$body_simple")"

body_indented=$'- branch:    release/2.0   \n'
expect_eq "parse: leading list marker is fine, value trimmed" "release/2.0" "$(pin_parse_branch "$body_indented")"

body_backtick=$'branch: `hotfix/x`'
expect_eq "parse: surrounding backticks stripped" "hotfix/x" "$(pin_parse_branch "$body_backtick")"

body_quoted=$'branch: "quoted/branch"'
expect_eq "parse: surrounding quotes stripped" "quoted/branch" "$(pin_parse_branch "$body_quoted")"

body_first_wins=$'branch: first/one\nbranch: second/two'
expect_eq "parse: first canonical line wins" "first/one" "$(pin_parse_branch "$body_first_wins")"

body_none=$'## What to build\njust some prose, no pin here'
expect_eq "parse: no line yields empty" "" "$(pin_parse_branch "$body_none")"
expect_fail "parse: no line returns non-zero" pin_parse_branch "$body_none"

body_prose=$'This branch: is a sentence, not a pin.\nWe will branch: later maybe'
expect_eq "parse: prose 'branch:' mid-sentence does not match" "" "$(pin_parse_branch "$body_prose")"

# ---------- pin_parse_parent_prd ----------

body_parent=$'## Parent\nPRD #59\n\n## What to build'
expect_eq "parent: PRD #59 extracted" "59" "$(pin_parse_parent_prd "$body_parent")"

body_parent_spaced=$'Parent: PRD # 12'
expect_eq "parent: 'PRD # 12' tolerates space" "12" "$(pin_parse_parent_prd "$body_parent_spaced")"

body_no_parent=$'## What to build\nno parent reference'
expect_eq "parent: none yields empty" "" "$(pin_parse_parent_prd "$body_no_parent")"
expect_fail "parent: none returns non-zero" pin_parse_parent_prd "$body_no_parent"

# ---------- pin_resolve (inheritance chain) ----------

issue_with_pin=$'## What to build\nbranch: issue/own'
prd_with_pin=$'## PRD\nbranch: prd/shared'

expect_eq "resolve: issue's own pin wins over PRD" "issue/own" \
  "$(pin_resolve "$issue_with_pin" "$prd_with_pin")"

issue_no_pin=$'## What to build\n## Parent\nPRD #59'
expect_eq "resolve: issue with no pin inherits PRD pin" "prd/shared" \
  "$(pin_resolve "$issue_no_pin" "$prd_with_pin")"

prd_no_pin=$'## PRD\nno pin here either'
expect_eq "resolve: no pin anywhere defaults to main" "main" \
  "$(pin_resolve "$issue_no_pin" "$prd_no_pin")"

expect_eq "resolve: issue-only, no PRD body, no pin -> main" "main" \
  "$(pin_resolve "$issue_no_pin")"

expect_eq "resolve: issue-only, no PRD body, own pin -> own" "issue/own" \
  "$(pin_resolve "$issue_with_pin")"

expect_ok "resolve: always returns 0" pin_resolve "$issue_no_pin" "$prd_no_pin"

# ---------- summary ----------
echo
echo "pin-reader: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
