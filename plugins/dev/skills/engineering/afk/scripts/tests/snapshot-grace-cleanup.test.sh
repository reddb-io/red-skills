#!/usr/bin/env bash
# Tests for issue #258 (PRD #244): remote-side grace-TTL cleanup of the
# afk-attempts/{wid}/{n}-{slug} snapshot branches for completed issues.
#
#   prune_completed_attempt_branches [root]
#     Lists the remote afk-attempts/* snapshot branches, groups them by issue,
#     classifies each issue via `gh issue view`, and deletes the branches of
#     issues that closed more than RED_AFK_ATTEMPT_SNAPSHOT_GRACE_S seconds ago.
#     Open issues, within-grace closed issues, and unclassifiable issues are
#     left strictly untouched. Best-effort, always rc 0, never on the close path.
#
# git and gh are mocked via PATH override:
#   - `git ... ls-remote ...` prints a fixture ref list.
#   - `git ... push origin --delete <branch>` is recorded (and can be flipped to
#     fail).
#   - `gh ... issue view <n> --json state,closedAt` prints a per-issue fixture
#     JSON written by the test.
# All other git verbs delegate to the real git so plumbing keeps working.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPTS="$(dirname "$HERE")"
LIB="$SCRIPTS/lib/remote-branch.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

GIT_LOG="$TMP/git.calls"
DELETE_FAIL_FILE="$TMP/delete.fail"
LSREMOTE_FILE="$TMP/ls-remote.out"
GH_DIR="$TMP/gh-meta"        # one <issue>.json fixture per issue
SHIM_DIR="$TMP/shim"
mkdir -p "$SHIM_DIR" "$GH_DIR"

REAL_GIT="$(command -v git)"

cat >"$SHIM_DIR/git" <<SHIM
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"$GIT_LOG"
# Find the verb after any leading "-C <dir>" pair.
verb=""; i=1
while (( i <= \$# )); do
  a="\${!i}"
  if [[ "\$a" == "-C" ]]; then i=\$((i+2)); continue; fi
  verb="\$a"; break
done
case "\$verb" in
  ls-remote) cat "$LSREMOTE_FILE" 2>/dev/null; exit 0 ;;
  push)
    # push origin --delete <branch>
    if [[ -f "$DELETE_FAIL_FILE" ]]; then exit 1; fi
    exit 0 ;;
  *) exec "$REAL_GIT" "\$@" ;;
esac
SHIM
chmod 0755 "$SHIM_DIR/git"

cat >"$SHIM_DIR/gh" <<SHIM
#!/usr/bin/env bash
printf 'gh %s\n' "\$*" >>"$GIT_LOG"
# gh -R <repo> issue view <n> --json state,closedAt
n=""; want_view=0; i=1
while (( i <= \$# )); do
  a="\${!i}"
  [[ "\$a" == "view" ]] && want_view=1
  if [[ "\$want_view" == 1 && "\$a" =~ ^[0-9]+\$ ]]; then n="\$a"; break; fi
  i=\$((i+1))
done
f="$GH_DIR/\$n.json"
if [[ -n "\$n" && -f "\$f" ]]; then cat "\$f"; exit 0; fi
exit 1
SHIM
chmod 0755 "$SHIM_DIR/gh"

export PATH="$SHIM_DIR:$PATH"

# gh_repo is defined in afk.sh, not the lib; the lib calls it at runtime. Provide
# a stub so the unit can resolve the repo slug.
gh_repo() { echo "owner/repo"; }

pass=0
fail=0

reset_calls() { : >"$GIT_LOG"; rm -f "$DELETE_FAIL_FILE"; }
calls()       { cat "$GIT_LOG"; }

expect_contains() {
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "PASS  $label"; pass=$((pass + 1))
  else
    printf 'FAIL  %s\n      missing: %q\n      in:       %q\n' "$label" "$needle" "$haystack"
    fail=$((fail + 1))
  fi
}

expect_not_contains() {
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "PASS  $label"; pass=$((pass + 1))
  else
    printf 'FAIL  %s\n      unexpected: %q\n      in:        %q\n' "$label" "$needle" "$haystack"
    fail=$((fail + 1))
  fi
}

expect_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "PASS  $label"; pass=$((pass + 1))
  else
    printf 'FAIL  %s\n      expected: %q\n      actual:   %q\n' "$label" "$expected" "$actual"
    fail=$((fail + 1))
  fi
}

expect_rc0() {
  local label="$1"; shift
  if "$@"; then echo "PASS  $label"; pass=$((pass + 1))
  else echo "FAIL  $label (returned non-zero: $*)"; fail=$((fail + 1)); fi
}

# An ISO-8601 UTC timestamp N seconds in the past (uses the same `date` the lib does).
iso_ago() { date -u -d "@$(( $(date +%s) - $1 ))" +%Y-%m-%dT%H:%M:%SZ; }

# Helper to write a gh fixture for an issue.
gh_fixture() { # <issue> <state> <closedAt-or-empty>
  local n="$1" state="$2" closed="$3"
  printf '{"state":"%s","closedAt":"%s"}\n' "$state" "$closed" >"$GH_DIR/$n.json"
}

DAY=86400
PROJECT_ROOT="$TMP"   # repo dir for `git -C`; real git verbs are delegated harmlessly

# shellcheck source=../lib/remote-branch.sh
source "$LIB"

# Remote ref fixture: three issues, two workers, two snapshots for #300.
cat >"$LSREMOTE_FILE" <<EOF
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa	refs/heads/afk-attempts/wAAA/300-old-completed
bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb	refs/heads/afk-attempts/wBBB/300-old-completed
cccccccccccccccccccccccccccccccccccccccc	refs/heads/afk-attempts/wAAA/301-fresh-completed
dddddddddddddddddddddddddddddddddddddddd	refs/heads/afk-attempts/wAAA/302-still-open
EOF

# #300 closed 30 days ago  → past a 7-day grace → branches deleted (cross-worker)
# #301 closed 1 day ago    → within a 7-day grace → kept
# #302 open                → never touched
gh_fixture 300 CLOSED "$(iso_ago $((30*DAY)))"
gh_fixture 301 CLOSED "$(iso_ago $((1*DAY)))"
gh_fixture 302 OPEN ""

# ---------- past-grace completed issue is deleted (cross-worker) ----------
reset_calls
RED_AFK_ATTEMPT_SNAPSHOT_GRACE_S=$((7*DAY)) \
  expect_rc0 "prune: returns 0" prune_completed_attempt_branches
log_out="$(calls)"
expect_contains "prune: deletes #300 wAAA snapshot (past grace)" "$log_out" "push origin --delete afk-attempts/wAAA/300-old-completed"
expect_contains "prune: deletes #300 wBBB snapshot (cross-worker)" "$log_out" "push origin --delete afk-attempts/wBBB/300-old-completed"

# ---------- within-grace completed issue survives ----------
expect_not_contains "prune: keeps #301 snapshot (within grace)" "$log_out" "--delete afk-attempts/wAAA/301-fresh-completed"

# ---------- still-open issue is never touched ----------
expect_not_contains "prune: never deletes open #302 snapshot" "$log_out" "--delete afk-attempts/wAAA/302-still-open"

# ---------- grace is configurable: a huge grace keeps everything ----------
reset_calls
RED_AFK_ATTEMPT_SNAPSHOT_GRACE_S=$((365*DAY)) prune_completed_attempt_branches
expect_not_contains "prune: 1y grace keeps #300 too" "$(calls)" "--delete afk-attempts/wAAA/300-old-completed"

# ---------- grace of 0 deletes any completed issue immediately ----------
reset_calls
RED_AFK_ATTEMPT_SNAPSHOT_GRACE_S=0 prune_completed_attempt_branches
expect_contains "prune: 0 grace deletes #301 (completed)" "$(calls)" "push origin --delete afk-attempts/wAAA/301-fresh-completed"
expect_not_contains "prune: 0 grace still spares open #302" "$(calls)" "--delete afk-attempts/wAAA/302-still-open"

# ---------- defensive grace reader: a typo falls back to the default, not disabled ----------
reset_calls
RED_AFK_ATTEMPT_SNAPSHOT_GRACE_S="not-a-number" prune_completed_attempt_branches
# Default grace is 7 days, so #300 (30d) deletes but #301 (1d) survives.
typo_out="$(calls)"
expect_contains "prune: typo grace falls back to default (deletes 30d-old #300)" "$typo_out" "push origin --delete afk-attempts/wAAA/300-old-completed"
expect_not_contains "prune: typo grace falls back to default (keeps 1d-old #301)" "$typo_out" "--delete afk-attempts/wAAA/301-fresh-completed"

# ---------- best-effort: a failing delete never changes the rc ----------
reset_calls
: >"$DELETE_FAIL_FILE"
RED_AFK_ATTEMPT_SNAPSHOT_GRACE_S=$((7*DAY)) \
  expect_rc0 "prune: tolerates a failing git delete" prune_completed_attempt_branches

# ---------- unclassifiable issue (gh error) is left untouched ----------
reset_calls
rm -f "$GH_DIR/300.json"   # gh now fails for #300 → cannot classify → skip
RED_AFK_ATTEMPT_SNAPSHOT_GRACE_S=$((7*DAY)) prune_completed_attempt_branches
expect_not_contains "prune: gh-error issue #300 left untouched" "$(calls)" "--delete afk-attempts/wAAA/300-old-completed"
gh_fixture 300 CLOSED "$(iso_ago $((30*DAY)))"   # restore for any later use

# ---------- no remote snapshots → rc 0 no-op ----------
reset_calls
: >"$LSREMOTE_FILE"
RED_AFK_ATTEMPT_SNAPSHOT_GRACE_S=$((7*DAY)) \
  expect_rc0 "prune: empty ref list is a rc-0 no-op" prune_completed_attempt_branches
expect_eq "prune: empty ref list issues no delete" "" "$(calls | grep -F -- '--delete' || true)"

# ---------- static guard: boot wires the prune after cap_issue_attempts ----------
expect_rc0 "guard: afk.sh boot calls prune_completed_attempt_branches" \
  grep -q 'prune_completed_attempt_branches' "$SCRIPTS/afk.sh"

# ---------- summary ----------
echo
echo "snapshot-grace-cleanup: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
