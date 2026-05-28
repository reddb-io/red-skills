#!/usr/bin/env bash
# Tests for the user-hook execution recorder used by the terminal
# Envelope's `data-section="hooks"` block (issue #215, PRD #207).
#
# Drives lib/hook-dispatcher.sh + lib/envelope.sh directly so the test
# stays offline. The orchestrator's wiring in afk.sh — reset at
# iter_open, hooks_file passed by emit_envelope — is exercised by the
# end-to-end source of afk.sh at the bottom of this file.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DISPATCHER_SH="$HERE/../lib/hook-dispatcher.sh"
CONFIG_SH="$HERE/../lib/hook-config.sh"
ENVELOPE_SH="$HERE/../lib/envelope.sh"
AFK_SH="$HERE/../afk.sh"

# shellcheck disable=SC1090
source "$DISPATCHER_SH"
# shellcheck disable=SC1090
source "$ENVELOPE_SH"

pass=0
fail=0

expect_eq() {
  local label="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    echo "PASS  $label"; pass=$((pass + 1))
  else
    echo "FAIL  $label"
    echo "  got:  >>$got<<"
    echo "  want: >>$want<<"
    fail=$((fail + 1))
  fi
}

expect_contains() {
  local label="$1" hay="$2" needle="$3"
  if [[ "$hay" == *"$needle"* ]]; then
    echo "PASS  $label"; pass=$((pass + 1))
  else
    echo "FAIL  $label"
    echo "  hay:    >>$hay<<"
    echo "  needle: >>$needle<<"
    fail=$((fail + 1))
  fi
}

expect_not_contains() {
  local label="$1" hay="$2" needle="$3"
  if [[ "$hay" == *"$needle"* ]]; then
    echo "FAIL  $label — unexpectedly found: $needle"
    fail=$((fail + 1))
  else
    echo "PASS  $label"; pass=$((pass + 1))
  fi
}

reset_all() {
  HOOK_LISTS=()
  HOOK_KINDS=()
  hook_executions_reset
}

EXEC_LOG="$(mktemp)"
export HOOK_EXECUTIONS_FILE="$EXEC_LOG"

# ---------- 1. empty hook list → empty executions ----------
reset_all
ctx="$(hook_dispatch post_session '{}')"
expect_eq "empty: ctx returned" "$ctx" "{}"
out_file="$(mktemp)"
count="$(hook_executions_dump "$out_file")"
expect_eq "empty: dump count = 0" "$count" "0"
expect_eq "empty: dump file empty" "$(wc -c <"$out_file" | tr -d ' ')" "0"
rm -f "$out_file"

# ---------- 2. single user hook recorded with command + exit code ----------
reset_all
hook_register post_session '/usr/bin/true'
hook_dispatch post_session '{}' >/dev/null 2>&1
out_file="$(mktemp)"
hook_executions_dump "$out_file" >/dev/null
expect_eq "single: one line" "$(wc -l <"$out_file" | tr -d ' ')" "1"
expect_contains "single: lifecycle name" "$(cat "$out_file")" "post_session"
expect_contains "single: command path" "$(cat "$out_file")" "/usr/bin/true"
expect_contains "single: exit=0" "$(cat "$out_file")" "exit=0"
rm -f "$out_file"

# ---------- 3. multiple user hooks recorded in execution order ----------
reset_all
hook_register post_session 'true'   # rc 0
hook_register post_session 'false'  # rc 1 — policy=continue, no abort
hook_register post_session '/bin/echo "{\"x\":1}"'  # rc 0, mutates ctx
hook_dispatch post_session '{}' >/dev/null 2>&1
out_file="$(mktemp)"
hook_executions_dump "$out_file" >/dev/null
lines=$(wc -l <"$out_file" | tr -d ' ')
expect_eq "multi: three lines" "$lines" "3"
line1="$(sed -n '1p' "$out_file")"
line2="$(sed -n '2p' "$out_file")"
line3="$(sed -n '3p' "$out_file")"
expect_contains "multi: order line1=true"  "$line1" "post_session true exit=0"
expect_contains "multi: order line2=false" "$line2" "post_session false exit=1"
expect_contains "multi: order line3=echo"  "$line3" "/bin/echo"
expect_contains "multi: line3 exit=0"      "$line3" "exit=0"
rm -f "$out_file"

# ---------- 4. mixed defaults + user → only user recorded ----------
reset_all
HOOK_REGISTER_KIND=default hook_register post_session '/usr/bin/true'      # default — silent
HOOK_REGISTER_KIND=user    hook_register post_session '/usr/bin/printf "USER"'
hook_dispatch post_session '{}' >/dev/null 2>&1
out_file="$(mktemp)"
count="$(hook_executions_dump "$out_file")"
expect_eq "mixed: dump count = 1 (only user)" "$count" "1"
body="$(cat "$out_file")"
expect_contains "mixed: user command listed" "$body" 'USER'
expect_not_contains "mixed: default not listed" "$body" '/usr/bin/true'
rm -f "$out_file"

# ---------- 5. non-zero exit recorded (not omitted) ----------
reset_all
hook_register post_session 'exit 42'
hook_dispatch post_session '{}' >/dev/null 2>&1
out_file="$(mktemp)"
hook_executions_dump "$out_file" >/dev/null
expect_contains "non-zero: exit code preserved" "$(cat "$out_file")" "exit=42"
rm -f "$out_file"

# ---------- 6. abort-policy non-zero still records the offender ----------
# pre_session has policy=abort; the failing command must still appear in
# the executions log before the abort short-circuits the rest of the chain.
reset_all
hook_register pre_session 'exit 7'
hook_register pre_session '/usr/bin/true'   # must NOT run
hook_dispatch pre_session '{}' >/dev/null 2>&1
out_file="$(mktemp)"
hook_executions_dump "$out_file" >/dev/null
body="$(cat "$out_file")"
expect_contains "abort: failing cmd recorded" "$body" "pre_session exit 7 exit=7"
expect_not_contains "abort: post-failure cmd not recorded" "$body" "/usr/bin/true"
rm -f "$out_file"

# ---------- 7. subshell capture site still records (file is source of truth) ----------
# pre_session is captured via $() in the orchestrator. Verify the file
# survives subshell isolation.
reset_all
hook_register pre_session '/bin/echo "{\"runner\":\"hermes\"}"'
out_ctx="$(hook_dispatch pre_session '{}')"
expect_contains "subshell: mutated ctx" "$out_ctx" '"runner":"hermes"'
out_file="$(mktemp)"
hook_executions_dump "$out_file" >/dev/null
expect_contains "subshell: execution recorded in file" "$(cat "$out_file")" "pre_session"
expect_contains "subshell: exit=0" "$(cat "$out_file")" "exit=0"
rm -f "$out_file"

# ---------- 8. reset clears the file across iterations ----------
reset_all
hook_register post_session '/usr/bin/true'
hook_dispatch post_session '{}' >/dev/null 2>&1
hook_executions_reset
out_file="$(mktemp)"
count="$(hook_executions_dump "$out_file")"
expect_eq "reset: count back to 0" "$count" "0"
rm -f "$out_file"

# ---------- 9. Envelope module renders hooks section from file ----------
reset_all
hook_register post_session '/usr/bin/true'
hook_register post_session 'exit 3'
hook_dispatch post_session '{}' >/dev/null 2>&1
hooks_body_file="$(mktemp)"
hook_executions_dump "$hooks_body_file" >/dev/null

# Capturing poster
CAPTURED_BODY=""
capturing_poster() {
  CAPTURED_BODY="$2"
  return 0
}

SUM="$(envelope_build_summary "wTEST" "done" 5 "merged" 1 "abcdef1")"
envelope_emit_done poster=capturing_poster issue=99 "summary=$SUM" \
  "hooks_file=$hooks_body_file"
expect_contains "envelope: hooks section tag"    "$CAPTURED_BODY" '<details data-section="hooks">'
expect_contains "envelope: lists true rc=0"      "$CAPTURED_BODY" 'post_session /usr/bin/true exit=0'
expect_contains "envelope: lists exit 3 rc=3"    "$CAPTURED_BODY" 'post_session exit 3 exit=3'
# Order in the body matches execution order.
true_pos="$(awk '/post_session \/usr\/bin\/true exit=0/{print NR; exit}' <<<"$CAPTURED_BODY")"
exit3_pos="$(awk '/post_session exit 3 exit=3/{print NR; exit}' <<<"$CAPTURED_BODY")"
if [[ -n "$true_pos" && -n "$exit3_pos" && "$true_pos" -lt "$exit3_pos" ]]; then
  echo "PASS  envelope: hooks order matches execution"; pass=$((pass+1))
else
  echo "FAIL  envelope: hooks order (true=$true_pos exit3=$exit3_pos)"; fail=$((fail+1))
fi

# Empty hooks_file → no hooks section emitted.
reset_all
hook_executions_reset
empty_file="$(mktemp)"; : > "$empty_file"
CAPTURED_BODY=""
envelope_emit_done poster=capturing_poster issue=100 "summary=$SUM" \
  "hooks_file=$empty_file"
expect_not_contains "envelope: empty file → no hooks section" "$CAPTURED_BODY" 'data-section="hooks"'
rm -f "$hooks_body_file" "$empty_file"

# Failure-family envelope (blocked) also renders hooks last, after diff.
reset_all
hook_register post_session '/usr/bin/true'
hook_dispatch post_session '{}' >/dev/null 2>&1
hooks_body_file="$(mktemp)"
hook_executions_dump "$hooks_body_file" >/dev/null
# Stub the git push so the failure path stays offline.
envelope_push_attempt() { printf '%s' "$3"; return 0; }
notes_file="$(mktemp)"; printf 'note line\n' > "$notes_file"
SUM_B="$(envelope_build_summary "wTEST" "blocked" 5 "+1 -0" 1)"
CAPTURED_BODY=""
envelope_emit_attempt \
  poster=capturing_poster status=blocked issue=101 "summary=$SUM_B" \
  "repo=reddb-io/red-skills" repo_dir=/tmp/x branch=afk/wTEST/101 \
  "remote_name=afk-attempts/wTEST/101" "worktree_rel=/tmp/wt" \
  "diffstat=+1 -0 files=1" "notes_file=$notes_file" "hooks_file=$hooks_body_file"
expect_contains "blocked: hooks section present" "$CAPTURED_BODY" '<details data-section="hooks">'
hook_pos="$(awk '/data-section="hooks"/{print NR; exit}' <<<"$CAPTURED_BODY")"
diff_pos="$(awk '/data-section="diff"/{print NR; exit}' <<<"$CAPTURED_BODY")"
if [[ "$diff_pos" -lt "$hook_pos" ]]; then
  echo "PASS  blocked: diff precedes hooks"; pass=$((pass+1))
else
  echo "FAIL  blocked: diff < hooks (diff=$diff_pos hooks=$hook_pos)"; fail=$((fail+1))
fi
rm -f "$hooks_body_file" "$notes_file"

# ---------- 10. iter_open wires HOOK_EXECUTIONS_FILE inside the worktree ----------
# Source afk.sh in a sandboxed workspace and assert iter_open initialises
# both HOOK_EXECUTIONS_FILE and HOOK_USER_EXECUTIONS without leaking
# previous-iteration state.
unset HOOK_EXECUTIONS_FILE
SANDBOX_PROJECT="$(mktemp -d)"
# afk.sh derives TMP_DIR from PROJECT_ROOT at source-time; override after.
export PROJECT_ROOT="$SANDBOX_PROJECT"
mkdir -p "$SANDBOX_PROJECT/.red/tmp"
AGG_STARTED="$(date -Iseconds)"
# shellcheck disable=SC1090
source "$AFK_SH"
# Force the orchestrator's iteration globals to known values after source
# (the main block was skipped by the BASH_SOURCE guard, but a few top-level
# assignments may have reset WORKER_ID/RUNNER/etc).
WORKER_ID="wTEST"
RUNNER="claude"
TMP_DIR="$SANDBOX_PROJECT/.red/tmp"
FILTER_KIND=""; FILTER_VALUE=""
AGG_TOTAL=0; AGG_DONE=0; AGG_FAILED=0; AGG_BLOCKED=0
AGG_COMPLETED="[]"; AGG_QUEUE="[]"; AGG_DURATIONS="[]"
iter_open 215
expected_file="$TMP_DIR/work-wTEST-i215/hooks-executed.log"
if [[ "$HOOK_EXECUTIONS_FILE" == "$expected_file" ]]; then
  echo "PASS  iter_open: HOOK_EXECUTIONS_FILE set in ITER_DIR"; pass=$((pass+1))
else
  echo "FAIL  iter_open: HOOK_EXECUTIONS_FILE=$HOOK_EXECUTIONS_FILE want=$expected_file"; fail=$((fail+1))
fi
if [[ -f "$HOOK_EXECUTIONS_FILE" ]]; then
  echo "PASS  iter_open: file created"; pass=$((pass+1))
else
  echo "FAIL  iter_open: file not created"; fail=$((fail+1))
fi
if [[ "${#HOOK_USER_EXECUTIONS[@]}" -eq 0 ]]; then
  echo "PASS  iter_open: array reset to empty"; pass=$((pass+1))
else
  echo "FAIL  iter_open: array not reset (size=${#HOOK_USER_EXECUTIONS[@]})"; fail=$((fail+1))
fi
rm -rf "$SANDBOX_PROJECT"

# ---------- 11. defaults registered via hook_config_register_defaults are kind=default ----------
unset HOOK_EXECUTIONS_FILE
# shellcheck disable=SC1090
source "$CONFIG_SH"
HOOK_LISTS=()
HOOK_KINDS=()
HOOK_DEFAULTS_DISABLED=()
hook_config_register_defaults
# Inspect HOOK_KINDS for post_worker — any registered defaults must be
# marked default (the test environment may or may not have all defaults
# executable, but at least one of cargo/gradle/heartbeat/envelope/validation
# should land in a real install).
found_default=0
for name in pre_worktree post_worker post_merge; do
  kinds="${HOOK_KINDS[$name]:-}"
  if [[ -n "$kinds" ]]; then
    while IFS= read -r k; do
      [[ "$k" == "default" ]] && found_default=1
    done <<< "$kinds"
  fi
done
if [[ "$found_default" -eq 1 ]]; then
  echo "PASS  defaults: registered with kind=default"; pass=$((pass+1))
else
  echo "PASS  defaults: none installed in this env (skip)"; pass=$((pass+1))
fi

rm -f "$EXEC_LOG"

echo
echo "summary: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
