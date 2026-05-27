#!/usr/bin/env bash
# Validate an AFK task envelope against .red/contracts/afk-task.schema.json.
#
# Structural checks performed (mirroring the schema):
#   - file parses as JSON and the root is an object
#   - every required top-level field is present
#   - enum-valued fields hold allowed values
#   - array fields are arrays
#   - status=blocked requires non-empty blocker_reason and next_human_action
#   - status=escalation_needed requires non-empty next_human_action
#   - "hollow success" is rejected: status=completed must not coexist with
#     a non-empty quality_gate_failures or any acceptance result that is
#     fail/unverified
#
# This script is intentionally jq-only — no node/python — so it can run in
# the same red-release.yml step shape as scripts/validate-agent-metadata.sh
# without pulling new dependencies into the release pipeline.
#
# Usage:
#   scripts/validate-afk-task-contract.sh <path/to/envelope.json> [<more.json> …]
#
# Exits non-zero on the first failure and prints a single 'error: …' line.

set -euo pipefail

if [ $# -eq 0 ]; then
  printf 'usage: %s <envelope.json> [more.json …]\n' "$0" >&2
  exit 2
fi

command -v jq >/dev/null 2>&1 || {
  printf 'error: jq not found on PATH\n' >&2
  exit 2
}

fail() {
  printf 'error: %s: %s\n' "$1" "$2" >&2
  exit 1
}

# Schema-level constants must stay in sync with afk-task.schema.json.
REQUIRED_KEYS=(
  status phase runner issue_number scope_summary
  non_goals acceptance_criteria_results changed_files
  verification_commands verification_results quality_gate_failures
  blocker_reason next_human_action remaining_risks
  confidence raw_runner_output_path
)
STATUS_ENUM='completed blocked escalation_needed'
PHASE_ENUM='analyze_issue execute_task verify_task fix_or_escalate finalize'
RUNNER_ENUM='claude codex hermes'
CONFIDENCE_ENUM='low medium high'
RESULT_ENUM='pass fail unverified'

in_enum() {
  local needle="$1"; shift
  local hay
  for hay in $1; do
    [ "$hay" = "$needle" ] && return 0
  done
  return 1
}

validate_file() {
  local file="$1"

  [ -f "$file" ] || fail "$file" "no such file"

  # parse + root-object check
  if ! jq -e 'type == "object"' "$file" >/dev/null 2>&1; then
    if ! jq -e . "$file" >/dev/null 2>&1; then
      fail "$file" "malformed JSON (did not parse)"
    fi
    fail "$file" "malformed JSON (root must be an object)"
  fi

  # required keys
  local key
  for key in "${REQUIRED_KEYS[@]}"; do
    jq -e --arg k "$key" 'has($k)' "$file" >/dev/null \
      || fail "$file" "missing required field: $key"
  done

  # enums
  local status phase runner confidence
  status=$(jq -r '.status' "$file")
  phase=$(jq -r '.phase' "$file")
  runner=$(jq -r '.runner' "$file")
  confidence=$(jq -r '.confidence' "$file")

  in_enum "$status"     "$STATUS_ENUM"     || fail "$file" "status not in {$STATUS_ENUM}: $status"
  in_enum "$phase"      "$PHASE_ENUM"      || fail "$file" "phase not in {$PHASE_ENUM}: $phase"
  in_enum "$runner"     "$RUNNER_ENUM"     || fail "$file" "runner not in {$RUNNER_ENUM}: $runner"
  in_enum "$confidence" "$CONFIDENCE_ENUM" || fail "$file" "confidence not in {$CONFIDENCE_ENUM}: $confidence"

  # issue_number is a positive integer
  jq -e '.issue_number | type == "number" and . == (. | floor) and . >= 1' "$file" >/dev/null \
    || fail "$file" "issue_number must be a positive integer"

  # scope_summary is a non-empty string
  jq -e '.scope_summary | type == "string" and length > 0' "$file" >/dev/null \
    || fail "$file" "scope_summary must be a non-empty string"

  # array-valued fields
  local arr
  for arr in non_goals acceptance_criteria_results changed_files \
             verification_commands verification_results \
             quality_gate_failures remaining_risks; do
    jq -e --arg k "$arr" '.[$k] | type == "array"' "$file" >/dev/null \
      || fail "$file" "$arr must be an array (use [] for empty)"
  done

  # acceptance_criteria_results item shape
  jq -e '
    .acceptance_criteria_results
    | all(
        type == "object"
        and (has("criterion") and (.criterion | type == "string" and length > 0))
        and (has("result")    and (.result    | . == "pass" or . == "fail" or . == "unverified"))
        and (has("evidence")  and (.evidence  | type == "string"))
      )
  ' "$file" >/dev/null \
    || fail "$file" "acceptance_criteria_results items must be {criterion, result(pass|fail|unverified), evidence}"

  # verification_results item shape
  jq -e '
    .verification_results
    | all(
        type == "object"
        and (has("command")   and (.command   | type == "string" and length > 0))
        and (has("exit_code") and (.exit_code | type == "number" and . == (. | floor)))
        and (has("summary")   and (.summary   | type == "string"))
      )
  ' "$file" >/dev/null \
    || fail "$file" "verification_results items must be {command, exit_code(int), summary}"

  # nullable-string fields
  local nfield
  for nfield in blocker_reason next_human_action raw_runner_output_path; do
    jq -e --arg k "$nfield" '.[$k] | (type == "string" or . == null)' "$file" >/dev/null \
      || fail "$file" "$nfield must be a string or null"
  done

  # status-conditional requirements
  if [ "$status" = "blocked" ]; then
    jq -e '.blocker_reason   | type == "string" and length > 0' "$file" >/dev/null \
      || fail "$file" "status=blocked requires non-empty blocker_reason"
    jq -e '.next_human_action | type == "string" and length > 0' "$file" >/dev/null \
      || fail "$file" "status=blocked requires non-empty next_human_action"
  fi
  if [ "$status" = "escalation_needed" ]; then
    jq -e '.next_human_action | type == "string" and length > 0' "$file" >/dev/null \
      || fail "$file" "status=escalation_needed requires non-empty next_human_action"
  fi

  # hollow-success detector
  if [ "$status" = "completed" ]; then
    if jq -e '.quality_gate_failures | length > 0' "$file" >/dev/null; then
      fail "$file" "hollow success: status=completed with non-empty quality_gate_failures"
    fi
    if jq -e '.acceptance_criteria_results | any(.result == "fail" or .result == "unverified")' "$file" >/dev/null; then
      fail "$file" "hollow success: status=completed with fail/unverified acceptance_criteria_results"
    fi
  fi
}

for arg in "$@"; do
  validate_file "$arg"
done

printf 'ok: %d envelope(s) valid\n' "$#"
