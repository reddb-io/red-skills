#!/usr/bin/env bash
# Regression tests for issue #99: terminal AFK Envelopes soft-record a Memory
# Reasoning attempt after the comment is posted, without changing Envelope bytes
# or terminal control flow.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
AFK_SH="$HERE/../afk.sh"

# shellcheck disable=SC1090
source "$AFK_SH"

pass=0
fail=0

expect_eq() {
  local label="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    echo "PASS  $label"; pass=$((pass + 1))
  else
    printf 'FAIL  %s\n      got:  %q\n      want: %q\n' "$label" "$got" "$want"
    fail=$((fail + 1))
  fi
}

expect_json_eq() {
  local label="$1" file="$2" jq_filter="$3" want="$4"
  local got
  got="$(jq -r "$jq_filter" "$file")"
  expect_eq "$label" "$got" "$want"
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PROJECT_ROOT="$TMP/repo"
mkdir -p "$PROJECT_ROOT"
git -C "$PROJECT_ROOT" init -q
git -C "$PROJECT_ROOT" config user.email test@example.invalid
git -C "$PROJECT_ROOT" config user.name "Test User"
printf 'base\n' > "$PROJECT_ROOT/file.txt"
git -C "$PROJECT_ROOT" add file.txt
git -C "$PROJECT_ROOT" commit -qm base
git -C "$PROJECT_ROOT" branch -M main
git -C "$PROJECT_ROOT" remote add origin git@github.com:reddb-io/red-skills.git
git -C "$PROJECT_ROOT" update-ref refs/remotes/origin/main HEAD
git -C "$PROJECT_ROOT" switch -qc afk/wTEST/99-memory-attempt
printf 'changed\n' > "$PROJECT_ROOT/file.txt"
mkdir -p "$PROJECT_ROOT/plugins/dev"
printf 'script\n' > "$PROJECT_ROOT/plugins/dev/new.sh"
git -C "$PROJECT_ROOT" add file.txt plugins/dev/new.sh
git -C "$PROJECT_ROOT" commit -qm change

STATE_FILE="$TMP/state.json"
ITER_LOG="$TMP/iter.log"
state_init "$STATE_FILE" envelope.posted:=false

WORKER_ID="wTEST"
RUNNER="codex"
CURRENT_ISSUE="99"
CURRENT_ISSUE_TITLE="AFK records terminal Envelopes as best-effort Reasoning attempts"
CURRENT_ISSUE_BODY=$'parent-prd: #95\n\n## What to build\nRecord attempts.'

POSTED_BODIES="$TMP/posted-bodies"
mkdir -p "$POSTED_BODIES"
POST_RC=0
POST_COUNT=0
_afk_envelope_poster() {
  POST_COUNT=$((POST_COUNT + 1))
  printf '%s' "$2" > "$POSTED_BODIES/$POST_COUNT.body"
  return "$POST_RC"
}

MEMORY_PAYLOAD_DIR="$TMP/memory-payloads"
mkdir -p "$MEMORY_PAYLOAD_DIR"
MEMORY_RC=0
MEMORY_COUNT=0
memory_record_attempt() {
  MEMORY_COUNT=$((MEMORY_COUNT + 1))
  cp "$2" "$MEMORY_PAYLOAD_DIR/$MEMORY_COUNT.json"
  return "$MEMORY_RC"
}

envelope_push_attempt() {
  printf '%s' "$3"
}

run_case() {
  local status="$1" expected_body_file="$2" expected_memory_delta="$3"
  shift 3
  local before="$MEMORY_COUNT"
  emit_envelope "$status" 99 125 afk/wTEST/99-memory-attempt 3 abc1234 memory-attempt ".red/tmp/work-wTEST-i99/worktree" "$@" || true
  local posted="$POSTED_BODIES/$POST_COUNT.body"
  if cmp -s "$posted" "$expected_body_file"; then
    echo "PASS  $status/envelope body unchanged"; pass=$((pass + 1))
  else
    echo "FAIL  $status/envelope body unchanged"; fail=$((fail + 1))
    diff -u "$expected_body_file" "$posted" || true
  fi
  expect_eq "$status/memory call count delta" "$((MEMORY_COUNT - before))" "$expected_memory_delta"
}

notes_file="$TMP/notes.md"
log_file="$TMP/log.txt"
validation_file="$TMP/validation.txt"
printf 'agent notes\n' > "$notes_file"
printf 'merge conflict log\n' > "$log_file"
printf 'test:plugins/dev:✓ typecheck:plugins/dev:skip\n' > "$validation_file"
validation_sidecar="$TMP/validation.jsonl"
cat > "$validation_sidecar" <<'EOF'
{"schema":"red.afk.validation.v1","name":"test:plugins/dev","command":"pnpm -C plugins/dev test","status":"passed","durationMs":1200,"summary":"shell tests passed"}
{"schema":"red.afk.validation.v1","name":"typecheck:plugins/dev","command":"pnpm -C plugins/dev typecheck","status":"skipped","summary":"script missing"}
EOF
malformed_sidecar="$TMP/validation-malformed.jsonl"
printf '{"schema":"red.afk.validation.v1","name":"test:plugins/dev","status":"passed"\n' > "$malformed_sidecar"

expect_eq "validation sidecar parser: valid records" "$(afk_validation_sidecar_records_json "$validation_sidecar" | jq -r 'length')" "2"
expect_eq "validation sidecar parser: missing file" "$(afk_validation_sidecar_records_json "$TMP/nope.jsonl" | jq -r 'length')" "0"
expect_eq "validation sidecar parser: malformed file" "$(afk_validation_sidecar_records_json "$malformed_sidecar" | jq -r 'length')" "0"

hooks_log="$TMP/hooks-executed.log"
printf 'pre_pick\tscripts/filter.sh --label slice:afk\t0\npost_pick\tscripts/audit.sh\t1\n' > "$hooks_log"
hooks_log_bad="$TMP/hooks-bad.log"
printf 'lifecycle_only\n\tjust\ttabs\n\t\tcommand_only\t\nbad\tcmd\tnotanumber\n' > "$hooks_log_bad"
hooks_log_empty="$TMP/hooks-empty.log"
: > "$hooks_log_empty"

expect_eq "hooks log parser: valid records" "$(afk_hooks_log_records_json "$hooks_log" | jq -r 'length')" "2"
expect_eq "hooks log parser: first lifecycle" "$(afk_hooks_log_records_json "$hooks_log" | jq -r '.[0].lifecycle')" "pre_pick"
expect_eq "hooks log parser: second exit code" "$(afk_hooks_log_records_json "$hooks_log" | jq -r '.[1].exit_code')" "1"
expect_eq "hooks log parser: drops malformed" "$(afk_hooks_log_records_json "$hooks_log_bad" | jq -r 'length')" "0"
expect_eq "hooks log parser: empty file" "$(afk_hooks_log_records_json "$hooks_log_empty" | jq -r 'length')" "0"
expect_eq "hooks log parser: missing file" "$(afk_hooks_log_records_json "$TMP/nope.log" | jq -r 'length')" "0"

SUM_DONE="$(build_envelope_summary done 125 merged 3 abc1234)"
EXPECT_DONE="$TMP/expect-done.body"
printf '%s' "$(envelope_build_body done "$SUM_DONE" validation "$validation_file")" > "$EXPECT_DONE"
run_case done "$EXPECT_DONE" 1 validation "$validation_file"
payload="$MEMORY_PAYLOAD_DIR/1.json"
expect_json_eq "done/payload status" "$payload" '.status' "done"
expect_json_eq "done/payload merge evidence" "$payload" '.mergeCommit' "abc1234"
expect_json_eq "done/payload validation summary" "$payload" '.validationSummary' "test:plugins/dev:✓ typecheck:plugins/dev:skip"
expect_json_eq "done/payload missing validation sidecar" "$payload" '.validationRecords // [] | length' "0"
expect_json_eq "done/payload touched files" "$payload" '.touchedFiles | join(",")' "file.txt,plugins/dev/new.sh"
expect_json_eq "done/payload envelope hash" "$payload" '.envelopeHash | test("^[0-9a-f]{64}$")' "true"

run_case done "$EXPECT_DONE" 1 validation "$validation_file" validation-sidecar "$validation_sidecar"
payload="$MEMORY_PAYLOAD_DIR/2.json"
expect_json_eq "done/sidecar payload count" "$payload" '.validationRecords | length' "2"
expect_json_eq "done/sidecar payload first name" "$payload" '.validationRecords[0].name' "test:plugins/dev"
expect_json_eq "done/sidecar payload first duration" "$payload" '.validationRecords[0].durationMs' "1200"
expect_json_eq "done/sidecar payload second status" "$payload" '.validationRecords[1].status' "skipped"

SUM_BLOCKED="$(build_envelope_summary blocked 125 "$(branch_diffstat afk/wTEST/99-memory-attempt)" 3 abc1234)"
diff_blocked="$TMP/diff-blocked.txt"
envelope_build_diff_section "$(gh_repo)" "afk-attempts/wTEST/99-memory-attempt" ".red/tmp/work-wTEST-i99/worktree" "$(branch_diffstat_full afk/wTEST/99-memory-attempt)" > "$diff_blocked"
EXPECT_BLOCKED="$TMP/expect-blocked.body"
printf '%s' "$(envelope_build_body blocked "$SUM_BLOCKED" notes "$notes_file" diff "$diff_blocked")" > "$EXPECT_BLOCKED"
run_case blocked "$EXPECT_BLOCKED" 1 notes "$notes_file"
payload="$MEMORY_PAYLOAD_DIR/3.json"
expect_json_eq "blocked/payload status" "$payload" '.status' "blocked"
expect_json_eq "blocked/payload failure branch" "$payload" '.failureBranch' "afk/wTEST/99-memory-attempt"
expect_json_eq "blocked/payload notes" "$payload" '.notes' "agent notes"
expect_json_eq "blocked/payload error class" "$payload" '.errorClass' "blocked"

SUM_NS="$(build_envelope_summary no-sentinel 125 "$(branch_diffstat afk/wTEST/99-memory-attempt)" 3 abc1234)"
diff_ns="$TMP/diff-ns.txt"
envelope_build_diff_section "$(gh_repo)" "afk-attempts/wTEST/99-memory-attempt" ".red/tmp/work-wTEST-i99/worktree" "$(branch_diffstat_full afk/wTEST/99-memory-attempt)" > "$diff_ns"
EXPECT_NS="$TMP/expect-ns.body"
printf '%s' "$(envelope_build_body no-sentinel "$SUM_NS" notes "$notes_file" diff "$diff_ns" log "$log_file")" > "$EXPECT_NS"
run_case no-sentinel "$EXPECT_NS" 1 notes "$notes_file" log "$log_file"
payload="$MEMORY_PAYLOAD_DIR/4.json"
expect_json_eq "no-sentinel/payload status" "$payload" '.status' "no-sentinel"
expect_json_eq "no-sentinel/payload error class" "$payload" '.errorClass' "no-sentinel"

SUM_MC="$(build_envelope_summary merge-conflict 125 "$(branch_diffstat afk/wTEST/99-memory-attempt)" 3 abc1234)"
diff_mc="$TMP/diff-mc.txt"
envelope_build_diff_section "$(gh_repo)" "afk-attempts/wTEST/99-memory-attempt" ".red/tmp/work-wTEST-i99/worktree" "$(branch_diffstat_full afk/wTEST/99-memory-attempt)" > "$diff_mc"
EXPECT_MC="$TMP/expect-mc.body"
printf '%s' "$(envelope_build_body merge-conflict "$SUM_MC" diff "$diff_mc" log "$log_file")" > "$EXPECT_MC"
run_case merge-conflict "$EXPECT_MC" 1 log "$log_file"
payload="$MEMORY_PAYLOAD_DIR/5.json"
expect_json_eq "merge-conflict/payload status" "$payload" '.status' "merge-conflict"
expect_json_eq "merge-conflict/payload notes include log" "$payload" '.notes' "merge conflict log"
expect_json_eq "merge-conflict/payload error class" "$payload" '.errorClass' "merge-conflict"

MEMORY_RC=9
before="$MEMORY_COUNT"
emit_envelope done 99 125 afk/wTEST/99-memory-attempt 3 abc1234 memory-attempt ".red/tmp/work-wTEST-i99/worktree" validation "$validation_file"
rc=$?
expect_eq "memory failure does not fail emit_envelope" "$rc" "0"
expect_eq "memory failure still called once" "$((MEMORY_COUNT - before))" "1"
state_read_into _state "$STATE_FILE"
expect_eq "memory failure preserves envelope posted state" "$_state_envelope_posted" "true"

POST_RC=1
before="$MEMORY_COUNT"
emit_envelope done 99 125 afk/wTEST/99-memory-attempt 3 abc1234 memory-attempt ".red/tmp/work-wTEST-i99/worktree" validation "$validation_file" && rc=0 || rc=$?
expect_eq "post failure still fails emit_envelope" "$rc" "1"
expect_eq "post failure does not call memory" "$((MEMORY_COUNT - before))" "0"

expect_json_eq "no-hooks-by-default payload omits hooks field" "$MEMORY_PAYLOAD_DIR/1.json" '.hooks // "missing"' "missing"

POST_RC=0
MEMORY_RC=0
export HOOK_EXECUTIONS_FILE="$hooks_log"
emit_envelope done 99 125 afk/wTEST/99-memory-attempt 3 abc1234 memory-attempt ".red/tmp/work-wTEST-i99/worktree" validation "$validation_file" || true
payload="$MEMORY_PAYLOAD_DIR/$MEMORY_COUNT.json"
expect_json_eq "with-hooks payload includes hooks length" "$payload" '.hooks | length' "2"
expect_json_eq "with-hooks payload first lifecycle" "$payload" '.hooks[0].lifecycle' "pre_pick"
expect_json_eq "with-hooks payload first command preserves spaces" "$payload" '.hooks[0].command' "scripts/filter.sh --label slice:afk"
expect_json_eq "with-hooks payload second exit_code" "$payload" '.hooks[1].exit_code' "1"
unset HOOK_EXECUTIONS_FILE

echo
echo "afk-memory-attempt: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
