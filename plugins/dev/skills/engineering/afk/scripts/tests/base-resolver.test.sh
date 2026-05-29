#!/usr/bin/env bash
# Tests for plugins/.../afk/scripts/lib/base-resolver.sh (issue #247).
#
# Sources the module directly (no orchestrator globals) and exercises the full
# precedence matrix the acceptance criteria name:
#   - lock value wins over any pin (and over none);
#   - pin wins when no lock is set;
#   - main when neither is set;
#   - the decision is pure — no git, no filesystem mutation.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPTS="$(dirname "$HERE")"
LIB="$SCRIPTS/lib/base-resolver.sh"

# shellcheck source=../lib/base-resolver.sh
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

# ---------- precedence matrix ----------

# AC1 — lock value wins, regardless of any pin.
expect_eq "lock beats pin" "release/lock" \
  "$(base_resolve "release/lock" "feature/pin")"

expect_eq "lock wins with no pin" "release/lock" \
  "$(base_resolve "release/lock" "")"

expect_eq "lock wins even when pin equals main" "release/lock" \
  "$(base_resolve "release/lock" "main")"

# AC2 — pin wins when no lock is set.
expect_eq "pin used when unlocked" "feature/pin" \
  "$(base_resolve "" "feature/pin")"

# AC3 — main when neither is set.
expect_eq "neither set -> main" "main" \
  "$(base_resolve "" "")"

expect_eq "no args at all -> main" "main" \
  "$(base_resolve)"

# ---------- empty / whitespace counts as "not set" ----------

expect_eq "whitespace-only lock falls through to pin" "feature/pin" \
  "$(base_resolve "   " "feature/pin")"

expect_eq "whitespace-only lock and pin -> main" "main" \
  "$(base_resolve "  " $'\t')"

# ---------- explicit default override ----------

expect_eq "custom default used when nothing set" "develop" \
  "$(base_resolve "" "" "develop")"

expect_eq "empty default collapses to main" "main" \
  "$(base_resolve "" "" "")"

expect_eq "default ignored once a pin exists" "feature/pin" \
  "$(base_resolve "" "feature/pin" "develop")"

expect_eq "default ignored once a lock exists" "release/lock" \
  "$(base_resolve "release/lock" "" "develop")"

# ---------- contract: always returns 0, no I/O ----------

expect_ok "always returns 0 (locked)"     base_resolve "release/lock" "feature/pin"
expect_ok "always returns 0 (pin)"         base_resolve "" "feature/pin"
expect_ok "always returns 0 (default)"     base_resolve "" ""

# The module defines only functions + the one helper; sourcing it (above)
# performed no git/filesystem work. Prove the helper itself is a pure predicate.
expect_ok "_base_is_set true on non-blank"  _base_is_set "x"
if _base_is_set "   "; then
  echo "FAIL  _base_is_set false on whitespace-only"
  fail=$((fail + 1))
else
  echo "PASS  _base_is_set false on whitespace-only"
  pass=$((pass + 1))
fi

# ---------- summary ----------
echo
echo "base-resolver: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
