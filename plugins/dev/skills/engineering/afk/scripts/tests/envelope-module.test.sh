#!/usr/bin/env bash
# Unit test for lib/envelope.sh — the deep Envelope Module (issue #47).
#
# Sources the module directly (no orchestrator globals) and exercises the two
# entry points, envelope_emit_attempt and envelope_emit_done, with the post
# side effect stubbed to a capturing no-op so only the composed text is
# asserted. The git push inside the failure path is stubbed by redefining the
# module's envelope_push_attempt — the module touches no live repo here.
#
# The composition is also checked byte-for-byte against envelope_build_body
# (the single schema definition) so we prove the entry points compose through
# the one builder rather than re-hand-rolling the wire shape.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ENVELOPE_SH="$HERE/../lib/envelope.sh"

# shellcheck disable=SC1090
source "$ENVELOPE_SH"

pass=0
fail=0

expect_contains() {
  local label="$1" haystack="$2" needle="$3"
  if grep -qF -- "$needle" <<<"$haystack"; then
    echo "PASS  $label"; pass=$((pass + 1))
  else
    echo "FAIL  $label — missing: $needle"
    echo "----- body -----"; echo "$haystack"; echo "----------------"
    fail=$((fail + 1))
  fi
}

expect_not_contains() {
  local label="$1" haystack="$2" needle="$3"
  if grep -qF -- "$needle" <<<"$haystack"; then
    echo "FAIL  $label — unexpectedly found: $needle"; fail=$((fail + 1))
  else
    echo "PASS  $label"; pass=$((pass + 1))
  fi
}

expect_eq() {
  local label="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    echo "PASS  $label"; pass=$((pass + 1))
  else
    echo "FAIL  $label — got [$got] want [$want]"; fail=$((fail + 1))
  fi
}

# ---------- capturing poster ----------
CAPTURED_BODY=""
CAPTURED_ISSUE=""
POSTER_RC=0
capturing_poster() {  # <issue> <body>
  CAPTURED_ISSUE="$1"
  CAPTURED_BODY="$2"
  return "$POSTER_RC"
}

# ---------- stub the git push so the failure path stays offline ----------
# Success route: echo a deterministic remote branch name.
PUSH_RESULT="ok"   # "ok" -> echo remote and succeed; "fail" -> emit nothing, fail
envelope_push_attempt() {  # <repo_dir> <branch> <remote_name>
  if [[ "$PUSH_RESULT" == "ok" ]]; then
    printf '%s' "$3"; return 0
  fi
  return 1
}

# ---------- fixtures ----------
notes_file="$(mktemp)"; printf 'agent could not reproduce, halted\n' > "$notes_file"
log_file="$(mktemp)";   printf 'line A\nline B\nline C\n' > "$log_file"

# ===========================================================================
# envelope_emit_attempt — blocked
# ===========================================================================
PUSH_RESULT="ok"; POSTER_RC=0
SUM_BLOCKED="$(envelope_build_summary "wTEST" "blocked" 125 "+42 -10" 1)"
envelope_emit_attempt \
  poster=capturing_poster status=blocked issue=11 "summary=$SUM_BLOCKED" \
  "repo=reddb-io/red-skills" repo_dir=/tmp/x branch=afk/wTEST/11-foo \
  "remote_name=afk-attempts/wTEST/11-foo" "worktree_rel=.red/tmp/work-wTEST-i11/worktree" \
  "diffstat=+42 -10 files=3" "notes_file=$notes_file"
rc=$?
expect_eq "blocked/returns poster rc 0" "$rc" "0"
expect_eq "blocked/poster saw issue 11" "$CAPTURED_ISSUE" "11"
expect_contains "blocked/status tag"       "$CAPTURED_BODY" '<details data-attempt-status="blocked">'
expect_contains "blocked/summary worker"   "$CAPTURED_BODY" 'worker `wTEST`'
expect_contains "blocked/notes section"    "$CAPTURED_BODY" '<details data-section="notes">'
expect_contains "blocked/notes body"       "$CAPTURED_BODY" 'agent could not reproduce, halted'
expect_contains "blocked/diff section"     "$CAPTURED_BODY" '<details data-section="diff">'
expect_contains "blocked/diff compare link" "$CAPTURED_BODY" 'compare/main...afk-attempts/wTEST/11-foo'
expect_contains "blocked/diffstat in diff" "$CAPTURED_BODY" '+42 -10 files=3'
expect_not_contains "blocked/no log section" "$CAPTURED_BODY" 'data-section="log"'

# section ordering: notes precedes diff
notes_pos="$(awk '/data-section="notes"/{print NR; exit}' <<<"$CAPTURED_BODY")"
diff_pos="$(awk '/data-section="diff"/{print NR; exit}' <<<"$CAPTURED_BODY")"
if [[ -n "$notes_pos" && -n "$diff_pos" && "$notes_pos" -lt "$diff_pos" ]]; then
  echo "PASS  blocked/notes before diff"; pass=$((pass+1))
else
  echo "FAIL  blocked/notes before diff (notes=$notes_pos diff=$diff_pos)"; fail=$((fail+1))
fi

# byte-for-byte: emit composes through envelope_build_body
diff_tmp="$(mktemp)"
envelope_build_diff_section "reddb-io/red-skills" "afk-attempts/wTEST/11-foo" \
  ".red/tmp/work-wTEST-i11/worktree" "+42 -10 files=3" > "$diff_tmp"
EXPECT_BLOCKED="$(envelope_build_body "blocked" "$SUM_BLOCKED" notes "$notes_file" diff "$diff_tmp")"
rm -f "$diff_tmp"
expect_eq "blocked/byte-for-byte == build_body" "$CAPTURED_BODY" "$EXPECT_BLOCKED"

# ===========================================================================
# envelope_emit_attempt — no-sentinel (notes, diff, log)
# ===========================================================================
PUSH_RESULT="ok"
SUM_NS="$(envelope_build_summary "wTEST" "no-sentinel" 30 "+0 -0" 1)"
envelope_emit_attempt \
  poster=capturing_poster status=no-sentinel issue=12 "summary=$SUM_NS" \
  "repo=reddb-io/red-skills" repo_dir=/tmp/x branch=afk/wTEST/12-foo \
  "remote_name=afk-attempts/wTEST/12-foo" "worktree_rel=.red/tmp/work-wTEST-i12/worktree" \
  "diffstat=+0 -0 files=0" "notes_file=$notes_file" "log_file=$log_file"
expect_contains "no-sentinel/status tag" "$CAPTURED_BODY" '<details data-attempt-status="no-sentinel">'
expect_contains "no-sentinel/notes section" "$CAPTURED_BODY" '<details data-section="notes">'
expect_contains "no-sentinel/diff section"  "$CAPTURED_BODY" '<details data-section="diff">'
expect_contains "no-sentinel/log section"   "$CAPTURED_BODY" '<details data-section="log">'
expect_contains "no-sentinel/log fenced"    "$CAPTURED_BODY" '```'
expect_contains "no-sentinel/log content"   "$CAPTURED_BODY" 'line C'
# ordering notes < diff < log
np="$(awk '/data-section="notes"/{print NR; exit}' <<<"$CAPTURED_BODY")"
dp="$(awk '/data-section="diff"/{print NR; exit}' <<<"$CAPTURED_BODY")"
lp="$(awk '/data-section="log"/{print NR; exit}' <<<"$CAPTURED_BODY")"
if [[ "$np" -lt "$dp" && "$dp" -lt "$lp" ]]; then
  echo "PASS  no-sentinel/order notes<diff<log"; pass=$((pass+1))
else
  echo "FAIL  no-sentinel/order notes<diff<log (n=$np d=$dp l=$lp)"; fail=$((fail+1))
fi

# ===========================================================================
# envelope_emit_attempt — merge-conflict (diff, log; no notes), push failed
# ===========================================================================
PUSH_RESULT="fail"
SUM_MC="$(envelope_build_summary "wTEST" "merge-conflict" 800 "+12 -3" 1)"
envelope_emit_attempt \
  poster=capturing_poster status=merge-conflict issue=13 "summary=$SUM_MC" \
  "repo=reddb-io/red-skills" repo_dir=/tmp/x branch=afk/wTEST/13-foo \
  "remote_name=afk-attempts/wTEST/13-foo" "worktree_rel=.red/tmp/work-wTEST-i13/worktree" \
  "diffstat=+12 -3 files=2" "log_file=$log_file"
expect_contains "merge-conflict/status tag" "$CAPTURED_BODY" '<details data-attempt-status="merge-conflict">'
expect_contains "merge-conflict/diff section" "$CAPTURED_BODY" '<details data-section="diff">'
expect_contains "merge-conflict/log section"  "$CAPTURED_BODY" '<details data-section="log">'
expect_not_contains "merge-conflict/no notes" "$CAPTURED_BODY" 'data-section="notes"'
# push failed -> fallback diff body, no compare link
expect_contains "merge-conflict/push-fail fallback" "$CAPTURED_BODY" 'push to `afk-attempts/` failed'
expect_not_contains "merge-conflict/no compare link" "$CAPTURED_BODY" 'compare/main...'

# ===========================================================================
# envelope_emit_attempt — discarded (supervisor adapter): summary section only
# ===========================================================================
sec_file="$(mktemp)"
printf 'slot: 0\nworker IDs: wAAAA,wBBBB\nfast deaths: 5\nsupervisor log: .red/tmp/afk-supervisor.log' > "$sec_file"
SUM_DISC="runner \`claude\` · status: discarded · cause: runner-broken, slot parked after 5 fast deaths"
envelope_emit_attempt \
  poster=capturing_poster status=discarded issue=7 "summary=$SUM_DISC" \
  "section_file=$sec_file"
expect_contains "discarded/status tag"  "$CAPTURED_BODY" '<details data-attempt-status="discarded">'
expect_contains "discarded/summary runner" "$CAPTURED_BODY" 'runner `claude`'
expect_contains "discarded/summary section" "$CAPTURED_BODY" '<details data-section="summary">'
expect_contains "discarded/slot index"   "$CAPTURED_BODY" 'slot: 0'
expect_contains "discarded/worker ids"    "$CAPTURED_BODY" 'worker IDs: wAAAA,wBBBB'
expect_not_contains "discarded/no notes"  "$CAPTURED_BODY" 'data-section="notes"'
expect_not_contains "discarded/no diff"   "$CAPTURED_BODY" 'data-section="diff"'
expect_not_contains "discarded/no log"    "$CAPTURED_BODY" 'data-section="log"'
# byte-for-byte vs build_body (discarded does not push)
EXPECT_DISC="$(envelope_build_body "discarded" "$SUM_DISC" summary "$sec_file")"
expect_eq "discarded/byte-for-byte == build_body" "$CAPTURED_BODY" "$EXPECT_DISC"
rm -f "$sec_file"

# ===========================================================================
# envelope_emit_done — section-less success envelope, no push
# ===========================================================================
PUSH_RESULT="fail"   # would fail if the done path ever pushed
SUM_DONE="$(envelope_build_summary "wTEST" "done" 600 "merged" 2 "abcdef1")"
envelope_emit_done poster=capturing_poster issue=20 "summary=$SUM_DONE"
rc=$?
expect_eq "done/returns poster rc 0" "$rc" "0"
expect_contains "done/status tag"        "$CAPTURED_BODY" '<details data-attempt-status="done">'
expect_contains "done/carries merge sha" "$CAPTURED_BODY" 'merge: `abcdef1`'
expect_not_contains "done/no diff section"  "$CAPTURED_BODY" 'data-section="diff"'
expect_not_contains "done/no notes section" "$CAPTURED_BODY" 'data-section="notes"'
expect_not_contains "done/no log section"   "$CAPTURED_BODY" 'data-section="log"'
EXPECT_DONE="$(envelope_build_body "done" "$SUM_DONE")"
expect_eq "done/byte-for-byte == build_body" "$CAPTURED_BODY" "$EXPECT_DONE"

validation_file="$(mktemp)"
printf 'test:plugins/memory:✓ typecheck:plugins/memory:skip\n' > "$validation_file"
envelope_emit_done poster=capturing_poster issue=20 "summary=$SUM_DONE" "validation_file=$validation_file"
rc=$?
expect_eq "done/validation returns poster rc 0" "$rc" "0"
expect_contains "done/validation section tag" "$CAPTURED_BODY" '<details data-section="validation">'
expect_contains "done/validation carries report" "$CAPTURED_BODY" 'test:plugins/memory:✓'

# ===========================================================================
# poster failure propagates as non-zero return
# ===========================================================================
POSTER_RC=1
envelope_emit_done poster=capturing_poster issue=21 "summary=$SUM_DONE" && rc=0 || rc=$?
expect_eq "done/poster failure -> non-zero rc" "$rc" "1"

# ---------- envelope_fmt_duration ----------
expect_eq "fmt_duration(0)"    "$(envelope_fmt_duration 0)"    "0m0s"
expect_eq "fmt_duration(65)"   "$(envelope_fmt_duration 65)"   "1m5s"
expect_eq "fmt_duration(3599)" "$(envelope_fmt_duration 3599)" "59m59s"

rm -f "$notes_file" "$log_file" "$validation_file"

echo
echo "summary: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
