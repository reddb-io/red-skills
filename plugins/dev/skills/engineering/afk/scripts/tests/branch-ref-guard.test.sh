#!/usr/bin/env bash
# Tests for AFK branch-ref construction and malformed nested-ref rejection.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LIB="$HERE/../lib/branch-ref.sh"

# shellcheck source=../lib/branch-ref.sh
source "$LIB"

pass=0
fail=0

expect_eq() {
  local label="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    echo "PASS  $label"; pass=$((pass + 1))
  else
    printf 'FAIL  %s\n  got:  >>%s<<\n  want: >>%s<<\n' "$label" "$got" "$want"
    fail=$((fail + 1))
  fi
}

expect_ok() {
  local label="$1"; shift
  if "$@"; then echo "PASS  $label"; pass=$((pass + 1))
  else echo "FAIL  $label (command failed: $*)"; fail=$((fail + 1)); fi
}

expect_not_ok() {
  local label="$1"; shift
  if "$@"; then echo "FAIL  $label (unexpectedly succeeded: $*)"; fail=$((fail + 1))
  else echo "PASS  $label"; pass=$((pass + 1)); fi
}

expect_matches_ref() {
  local label="$1" ref="$2" wid="$3" issue="$4"
  if [[ "$ref" =~ ^afk(-attempts)?/${wid}/${issue}-[a-z0-9-]+$ ]]; then
    echo "PASS  $label"; pass=$((pass + 1))
  else
    echo "FAIL  $label — malformed ref: $ref"; fail=$((fail + 1))
  fi
}

expect_slug_has_no_afk_token() {
  local label="$1" ref="$2"
  local slug="${ref#*/}"
  slug="${slug#*/}"
  slug="${slug#*-}"
  if [[ "$slug" == *"afk/"* ]]; then
    echo "FAIL  $label — slug contains embedded afk/ token: $slug"; fail=$((fail + 1))
  else
    echo "PASS  $label"; pass=$((pass + 1))
  fi
}

# Matrix: namespace x worker x issue x title. Expected slugs preserve the
# historical slugify contract, including the 40-character byte cut.
while IFS='|' read -r wid issue title expected_slug; do
  [[ -n "$wid" ]] || continue
  for ns in afk afk-attempts; do
    ref="$(afk_ref_build "$ns" "$wid" "$issue" "$title")"
    expect_eq "build $ns/$wid/$issue from title" "$ref" "$ns/$wid/$issue-$expected_slug"
    expect_matches_ref "shape $ns/$wid/$issue" "$ref" "$wid" "$issue"
    expect_slug_has_no_afk_token "slug has no afk/ token $ns/$wid/$issue" "$ref"
  done
done <<'CASES'
wPMN2|272|AFK reaper: well-formed branch refs + slug guard (kill double-nested names)|afk-reaper-well-formed-branch-refs-slug-
wAB12|5|Use /afk attempt cleanup!|use-afk-attempt-cleanup
w9Z0|100|Already good slug|already-good-slug
CASES

# Known regression: the old bad shape nested the live branch inside the
# snapshot namespace, e.g. afk-attempts/{wid}/{issue}-afk/{wid}/{issue}-{slug}.
known_bad="afk-attempts/wPMN2/272-afk/wPMN2/272-afk-reaper-well-formed-branch-refs-slug-"
expect_not_ok "known double-nested ref is rejected" afk_ref_validate "$known_bad"

bad_slug="afk/wPMN2/272-afk-reaper-well-formed-branch-refs-slug-"
expect_not_ok "branch-like slug is rejected before construction" \
  afk_ref_build_from_slug afk-attempts wPMN2 272 "$bad_slug"

legacy_good="$(afk_ref_build_from_slug afk-attempts wPMN2 272 afk-reaper-well-formed-branch-refs-slug-)"
expect_eq "well-formed slug keeps existing snapshot ref" \
  "$legacy_good" "afk-attempts/wPMN2/272-afk-reaper-well-formed-branch-refs-slug-"

expect_not_ok "unknown namespace rejected" afk_ref_build nope wPMN2 272 "Some title"
expect_not_ok "slash in worker rejected" afk_ref_build afk "wPM/N2" 272 "Some title"
expect_not_ok "non-numeric issue rejected" afk_ref_build afk wPMN2 "272x" "Some title"
expect_not_ok "empty slug rejected" afk_ref_build_from_slug afk wPMN2 272 ""

echo
echo "branch-ref-guard: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
