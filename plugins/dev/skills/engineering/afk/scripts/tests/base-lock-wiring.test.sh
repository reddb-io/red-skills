#!/usr/bin/env bash
# Tests for the branch-lock → base wiring in afk.sh (ADR 0031, issue #253).
#
# base_resolve itself is unit-tested in base-resolver.test.sh; this exercises
# the orchestrator wiring — resolve_pinned_branch reads the lock file in the
# primary checkout and resolves with precedence lock > pin > main, and
# afk_is_locked reports the lock state that drives the lock-toggled landing.
#
# afk.sh is sourced (its BASH_SOURCE guard skips the orchestrator main block).
# No network: the test bodies never carry a parent-PRD ref, so resolve_pinned_
# branch never shells out to `gh`.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
AFK_SH="$HERE/../afk.sh"

# shellcheck disable=SC1090
source "$AFK_SH"

pass=0
fail=0
ok()  { echo "PASS  $1"; pass=$((pass + 1)); }
bad() { echo "FAIL  $1${2:+ ($2)}"; fail=$((fail + 1)); }
assert_eq() {
  local label="$1" want="$2" got="$3"
  if [[ "$want" == "$got" ]]; then ok "$label"; else bad "$label" "want=$want got=$got"; fi
}

# Sandbox primary checkout. resolve_pinned_branch reads
# $PROJECT_ROOT/.red/tmp/branch-lock.yaml.
PROJECT_ROOT="$(mktemp -d -t afk-lock.XXXXXX)"
trap 'rm -rf "$PROJECT_ROOT"' EXIT
mkdir -p "$PROJECT_ROOT/.red/tmp"
LOCKFILE="$PROJECT_ROOT/.red/tmp/branch-lock.yaml"

PIN_BODY=$'## What to build\nstuff\n\nbranch: feature/some-pin\n'
NOPIN_BODY=$'## What to build\nstuff with no pin line\n'

# ---------- locked: lock wins over everything ----------
printf 'work-branch\n' > "$LOCKFILE"
assert_eq "locked + no pin → locked branch"      "work-branch" "$(resolve_pinned_branch "$NOPIN_BODY")"
assert_eq "locked overrides an issue pin"         "work-branch" "$(resolve_pinned_branch "$PIN_BODY")"
if afk_is_locked; then ok "afk_is_locked: 0 when locked"; else bad "afk_is_locked: expected locked"; fi

# ---------- unlocked: fall through to pin, then main ----------
rm -f "$LOCKFILE"
assert_eq "unlocked + pin → pinned branch"        "feature/some-pin" "$(resolve_pinned_branch "$PIN_BODY")"
assert_eq "unlocked + no pin → main"              "main"             "$(resolve_pinned_branch "$NOPIN_BODY")"
if afk_is_locked; then bad "afk_is_locked: expected unlocked"; else ok "afk_is_locked: 1 when unlocked"; fi

# ---------- empty lock file is treated as unlocked ----------
: > "$LOCKFILE"
assert_eq "empty lock file → unlocked (pin wins)" "feature/some-pin" "$(resolve_pinned_branch "$PIN_BODY")"
if afk_is_locked; then bad "afk_is_locked: empty file should read unlocked"; else ok "afk_is_locked: 1 on empty lock file"; fi

echo
echo "summary: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
