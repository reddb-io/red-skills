#!/usr/bin/env bash
# Unit tests for count_blocked_since_guidance — the per-issue BLOCKED cap
# counter (PRD #29 Track B). Sources afk.sh and exercises the pure function
# against synthetic comments_json fixtures. No network, no filesystem.

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
    echo "FAIL  $label — expected $expected got $actual"
    fail=$((fail + 1))
  fi
}

# ---------- fixture builders ----------

envelope_blocked() {
  # $1: worker, $2: attempt
  printf '<details data-attempt-status="blocked"><summary>worker `%s` · status: blocked · duration: 0m30s · diff: +1 -0 · attempt: %s</summary>\n\nbody\n</details>' "$1" "$2"
}

envelope_done() {
  printf '<details data-attempt-status="done"><summary>worker `%s` · status: done · duration: 1m0s · merge: `deadbee`</summary>\n\n</details>' "$1"
}

directive_carrier_body() {
  printf 'Please retry with this guidance:\n\n<details data-kind="directive">\nrelax the second acceptance criterion\n</details>\n\nthanks!'
}

thread_discussion_body() {
  printf 'i wonder if the API surface should change here\n\njust thinking out loud'
}

audit_boot_stamp() {
  printf '🤖 /afk started at `2026-05-19T10:00:00-03:00` on runner `claude` (worker `wTEST`).'
}

audit_promotion() {
  printf '🤖 /afk promoted to ready-for-agent.'
}

audit_heartbeat() {
  printf ':one:'
}

# build_comments_json <body1> <body2> ...   →  JSON array of {body} objects
build_comments_json() {
  local first=1 body
  printf '['
  for body in "$@"; do
    [[ $first -eq 1 ]] || printf ','
    first=0
    jq -nc --arg b "$body" '{author: {login: "@op"}, body: $b, createdAt: "2026-05-19T10:00:00Z"}'
  done
  printf ']'
}

# ---------- assertions ----------

# Empty comments_json → 0.
expect_eq "empty array → 0"        0 "$(count_blocked_since_guidance '[]')"
expect_eq "empty string → 0"       0 "$(count_blocked_since_guidance '')"
expect_eq "null → 0"               0 "$(count_blocked_since_guidance 'null')"

# Single BLOCKED envelope at the end → 1.
J="$(build_comments_json "$(envelope_blocked w1 1)")"
expect_eq "single trailing blocked → 1" 1 "$(count_blocked_since_guidance "$J")"

# K BLOCKED envelopes consecutive with no directive_carrier ever → K.
for K in 2 3 5; do
  args=()
  for ((i = 0; i < K; i++)); do
    args+=("$(envelope_blocked "w$i" $((i + 1)))")
  done
  J="$(build_comments_json "${args[@]}")"
  expect_eq "K=$K consecutive blocked → $K" "$K" "$(count_blocked_since_guidance "$J")"
done

# K BLOCKED envelopes followed by a directive_carrier more recent than all
# of them → 0.
J="$(build_comments_json \
  "$(envelope_blocked w1 1)" \
  "$(envelope_blocked w2 2)" \
  "$(envelope_blocked w3 3)" \
  "$(directive_carrier_body)" \
)"
expect_eq "trailing directive_carrier resets to 0" 0 "$(count_blocked_since_guidance "$J")"

# K BLOCKED envelopes followed by a thread_discussion comment more recent
# than all of them → K (narrative does not reset; only directive_carrier does).
J="$(build_comments_json \
  "$(envelope_blocked w1 1)" \
  "$(envelope_blocked w2 2)" \
  "$(envelope_blocked w3 3)" \
  "$(thread_discussion_body)" \
)"
expect_eq "trailing thread_discussion does not reset" 3 "$(count_blocked_since_guidance "$J")"

# Interleaved BLOCKED + DONE envelopes → counts only the trailing-BLOCKED run.
# Order (oldest → newest): BLOCKED, BLOCKED, DONE, BLOCKED, BLOCKED.
# Trailing run is two BLOCKEDs.
J="$(build_comments_json \
  "$(envelope_blocked w1 1)" \
  "$(envelope_blocked w2 2)" \
  "$(envelope_done w3)" \
  "$(envelope_blocked w4 4)" \
  "$(envelope_blocked w5 5)" \
)"
expect_eq "DONE breaks the trailing-BLOCKED run" 2 "$(count_blocked_since_guidance "$J")"

# BLOCKEDs interleaved with audit_noise → count keeps growing.
# Order (oldest → newest): BLOCKED, boot-stamp, BLOCKED, promotion, BLOCKED,
# heartbeat. Trailing run skips audits, count = 3.
J="$(build_comments_json \
  "$(envelope_blocked w1 1)" \
  "$(audit_boot_stamp)" \
  "$(envelope_blocked w2 2)" \
  "$(audit_promotion)" \
  "$(envelope_blocked w3 3)" \
  "$(audit_heartbeat)" \
)"
expect_eq "audit_noise does not reset" 3 "$(count_blocked_since_guidance "$J")"

# Defensive: a directive_carrier sandwiched between trailing BLOCKEDs stops
# the count at the BLOCKEDs newer than the carrier.
J="$(build_comments_json \
  "$(envelope_blocked w1 1)" \
  "$(envelope_blocked w2 2)" \
  "$(directive_carrier_body)" \
  "$(envelope_blocked w3 3)" \
  "$(envelope_blocked w4 4)" \
)"
expect_eq "directive_carrier splits — only newer BLOCKEDs counted" 2 "$(count_blocked_since_guidance "$J")"

# Single non-blocked envelope → 0.
J="$(build_comments_json "$(envelope_done w1)")"
expect_eq "single done envelope → 0" 0 "$(count_blocked_since_guidance "$J")"

# Only audit noise → 0.
J="$(build_comments_json "$(audit_boot_stamp)" "$(audit_heartbeat)")"
expect_eq "only audit_noise → 0" 0 "$(count_blocked_since_guidance "$J")"

echo
echo "summary: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
