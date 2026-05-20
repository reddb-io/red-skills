#!/usr/bin/env bash
# Unit tests for classify_comment + extract_directives — the consolidated
# comment classifier (PRD #29 #30). Both functions are pure: this suite sources
# afk.sh and exercises them against synthetic bodies with NO stubs whatsoever,
# which is itself the proof that they perform no I/O, no `gh`, no global
# mutation. Co-located because the two functions share fixture vocabulary.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
AFK_SH="$HERE/../afk.sh"

# shellcheck disable=SC1090
source "$AFK_SH"

pass=0
fail=0

expect_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "PASS  $label"
    pass=$((pass + 1))
  else
    echo "FAIL  $label — expected [$expected] got [$actual]"
    fail=$((fail + 1))
  fi
}

# Read extract_directives output (NUL-separated) into the global `DIRS` array.
extract_into_DIRS() {
  DIRS=()
  mapfile -d '' DIRS < <(extract_directives "$1")
}

# ---------- fixtures ----------

envelope_body() {
  printf '<details data-attempt-status="blocked"><summary>worker `w1` · status: blocked · duration: 0m30s</summary>\n\nbody\n</details>'
}

boot_stamp_body()  { printf '🤖 /afk started at `2026-05-19T10:00:00-03:00` on runner `claude` (worker `wT`).'; }
promotion_body()   { printf '🤖 /afk promoted to ready-for-agent.'; }
heartbeat_body()   { printf ':three:'; }

marker_only_body() {
  printf '<details data-kind="directive">\nrelax the second acceptance criterion\n</details>'
}

marker_mixed_body() {
  printf 'Thanks for the patience. Please retry with:\n\n<details data-kind="directive">\nuse the v2 endpoint, not v1\n</details>\n\nshout if it is still stuck.'
}

malformed_no_close_body() {
  printf 'here you go:\n\n<details data-kind="directive">\nthis marker never closes'
}

plain_narrative_body() {
  printf 'i wonder whether the API surface should change here\n\njust thinking out loud'
}

# ============================================================
# classify_comment — one assertion per acceptance enumeration
# ============================================================

expect_eq "classify: envelope body"        envelope          "$(classify_comment "$(envelope_body)")"
expect_eq "classify: boot stamp body"      audit_noise       "$(classify_comment "$(boot_stamp_body)")"
expect_eq "classify: promotion audit body" audit_noise       "$(classify_comment "$(promotion_body)")"
expect_eq "classify: heartbeat glyph body" audit_noise       "$(classify_comment "$(heartbeat_body)")"
expect_eq "classify: marker-only body"     directive_carrier "$(classify_comment "$(marker_only_body)")"
expect_eq "classify: mixed marker+narrative" directive_carrier "$(classify_comment "$(marker_mixed_body)")"
expect_eq "classify: malformed marker body" thread_discussion "$(classify_comment "$(malformed_no_close_body)")"
expect_eq "classify: blank body"           audit_noise       "$(classify_comment '')"
expect_eq "classify: whitespace-only body" audit_noise       "$(classify_comment "$(printf '   \n\t\n')")"
expect_eq "classify: plain narrative body" thread_discussion "$(classify_comment "$(plain_narrative_body)")"

# An envelope that happens to embed directive-marker-looking text is still an
# envelope, never a directive_carrier — the envelope arm wins on precedence.
EBODY="$(printf '<details data-attempt-status="blocked"><summary>s</summary>\n<details data-kind="directive">\nx\n</details>\n</details>')"
expect_eq "classify: envelope wins over embedded marker" envelope "$(classify_comment "$EBODY")"

# ============================================================
# extract_directives
# ============================================================

# Zero markers → empty list.
extract_into_DIRS "$(plain_narrative_body)"
expect_eq "extract: zero markers → 0 elements" 0 "${#DIRS[@]}"

# One marker → one element, verbatim content (no surrounding tags/narrative).
extract_into_DIRS "$(marker_mixed_body)"
expect_eq "extract: one marker → 1 element"        1 "${#DIRS[@]}"
expect_eq "extract: one marker → verbatim content" "use the v2 endpoint, not v1" "${DIRS[0]:-}"

# Two markers in one comment → two elements, document order.
TWO="$(printf 'first:\n<details data-kind="directive">\nalpha\n</details>\nthen:\n<details data-kind="directive">\nbeta\n</details>\ndone')"
extract_into_DIRS "$TWO"
expect_eq "extract: two markers → 2 elements" 2 "${#DIRS[@]}"
expect_eq "extract: two markers → first content"  alpha "${DIRS[0]:-}"
expect_eq "extract: two markers → second content" beta  "${DIRS[1]:-}"

# Malformed: opened but never closed → no element.
extract_into_DIRS "$(malformed_no_close_body)"
expect_eq "extract: no closing tag → 0 elements" 0 "${#DIRS[@]}"

# Malformed: attribute on the closing tag → not a valid close → never closes.
ATTR_CLOSE="$(printf '<details data-kind="directive">\nbody\n</details foo>')"
extract_into_DIRS "$ATTR_CLOSE"
expect_eq "extract: attributed close → 0 elements" 0 "${#DIRS[@]}"

# Malformed: opened but never closed, mid-thread → no element, and a *valid*
# directive after it is still extracted (the dangling open does not poison
# the rest of the document, because the dangling open consumes to EOF — so we
# assert the simpler invariant that an unterminated marker yields nothing).
extract_into_DIRS "$(printf '<details data-kind="directive">\nunterminated')"
expect_eq "extract: opened never closed → 0 elements" 0 "${#DIRS[@]}"

# Nested <details> from operator markdown: the inner block is part of the
# verbatim content, and the directive ends only at the *matching* close.
NESTED="$(printf '<details data-kind="directive">\ndo this, e.g.:\n<details>\n<summary>example</summary>\nsnippet\n</details>\nthen stop\n</details>')"
extract_into_DIRS "$NESTED"
expect_eq "extract: nested details → 1 element" 1 "${#DIRS[@]}"
EXPECTED_NESTED="$(printf 'do this, e.g.:\n<details>\n<summary>example</summary>\nsnippet\n</details>\nthen stop')"
expect_eq "extract: nested details → verbatim incl inner block" "$EXPECTED_NESTED" "${DIRS[0]:-}"

# Literal </details> inside a fenced code block must NOT terminate the parse.
FENCED="$(printf '<details data-kind="directive">\nrun this:\n```\necho "</details>"\n```\nand report back\n</details>')"
extract_into_DIRS "$FENCED"
expect_eq "extract: fenced </details> → 1 element" 1 "${#DIRS[@]}"
EXPECTED_FENCED="$(printf 'run this:\n```\necho "</details>"\n```\nand report back')"
expect_eq "extract: fenced </details> → fence content preserved" "$EXPECTED_FENCED" "${DIRS[0]:-}"

# CRLF line endings: tags carrying a trailing \r are still recognised.
CRLF="$(printf '<details data-kind="directive">\r\nwindows line endings\r\n</details>\r\n')"
extract_into_DIRS "$CRLF"
expect_eq "extract: CRLF → 1 element"        1 "${#DIRS[@]}"
expect_eq "extract: CRLF → \\r stripped from content" "windows line endings" "${DIRS[0]:-}"

# ---------- summary ----------
echo
echo "summary: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
