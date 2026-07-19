#!/usr/bin/env bash
# Unit test for lib/lock-store.sh (issue #60).
#
# Sources the module directly (no globals) and exercises all four entry points
# against temp lock files:
#   - write/read round-trip, including a branch name with a slash
#   - absent file => unlocked (read rc 1, no output; is_locked rc 1)
#   - clear removes the file and is idempotent
#   - write is atomic and overwrites (relock to a new target)

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LIB="$(dirname "$HERE")/lib/lock-store.sh"

# shellcheck source=../lib/lock-store.sh
source "$LIB"

pass=0
fail=0

expect_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "PASS  $label"; pass=$((pass + 1))
  else
    printf 'FAIL  %s\n      expected: %q\n      actual:   %q\n' "$label" "$expected" "$actual"
    fail=$((fail + 1))
  fi
}

# ===========================================================================
# absent file => unlocked
# ===========================================================================
tmpdir="$(mktemp -d)"
lock="$tmpdir/.red/tmp/branch-lock.yaml"

out="$(lock_store_read "$lock")"; rc=$?
expect_eq "absent/read rc 1"        "1"  "$rc"
expect_eq "absent/read silent"      ""   "$out"
lock_store_is_locked "$lock"; rc=$?
expect_eq "absent/is_locked rc 1"   "1"  "$rc"

# ===========================================================================
# write / read round-trip (parent dir created, slash branch preserved)
# ===========================================================================
lock_store_write "$lock" "feature/branch-lock"; rc=$?
expect_eq "write/rc 0"              "0"  "$rc"
expect_eq "write/file exists"       "1"  "$([[ -f "$lock" ]] && echo 1 || echo 0)"
expect_eq "write/read back"         "feature/branch-lock"  "$(lock_store_read "$lock")"
lock_store_is_locked "$lock"; rc=$?
expect_eq "write/is_locked rc 0"    "0"  "$rc"
# stored content is a single line (no trailing whitespace in the value)
expect_eq "write/single line"       "1"  "$(wc -l < "$lock" | tr -d ' ')"

# ===========================================================================
# write overwrites (relock to a new target)
# ===========================================================================
lock_store_write "$lock" "main"
expect_eq "relock/read new target"  "main"  "$(lock_store_read "$lock")"

# missing arg => rc 2, file untouched
lock_store_write "$lock" "" 2>/dev/null; rc=$?
expect_eq "write/missing branch rc 2" "2"  "$rc"
expect_eq "write/untouched after bad" "main" "$(lock_store_read "$lock")"

# ===========================================================================
# clear removes the file and is idempotent
# ===========================================================================
lock_store_clear "$lock"; rc=$?
expect_eq "clear/rc 0"              "0"  "$rc"
expect_eq "clear/file gone"         "0"  "$([[ -f "$lock" ]] && echo 1 || echo 0)"
lock_store_clear "$lock"; rc=$?
expect_eq "clear/idempotent rc 0"   "0"  "$rc"
lock_store_is_locked "$lock"; rc=$?
expect_eq "clear/is_locked rc 1"    "1"  "$rc"

# ===========================================================================
# an empty lock file reads as unlocked (defensive: half-written / truncated)
# ===========================================================================
mkdir -p "$(dirname "$lock")"; : > "$lock"
out="$(lock_store_read "$lock")"; rc=$?
expect_eq "empty/read rc 1"         "1"  "$rc"
expect_eq "empty/read silent"       ""   "$out"

rm -rf "$tmpdir"

echo
echo "summary: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
