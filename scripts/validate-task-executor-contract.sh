#!/usr/bin/env bash
# Validate an AFK task-executor envelope against
# .red/contracts/task-executor.schema.json.
#
# The task-executor envelope is the execute_task specialization of the base
# AFK task envelope (see scripts/validate-afk-task-contract.sh): the base
# fields are validated identically, plus the execute-phase invariants below
# and the executor-specific `execution` object.
#
# Execute-phase invariants enforced here:
#   - phase MUST equal "execute_task"
#   - verification_commands, verification_results, quality_gate_failures
#     MUST all be empty arrays (the executor never runs quality gates;
#     verify_task owns them)
#   - every acceptance_criteria_results[*].result MUST be "unverified" (the
#     executor mirrors the brief's checklist and points at the change it
#     made; verify_task is the one that grades pass/fail)
#   - status == "completed" requires:
#       * changed_files is non-empty
#       * every execution.changes_by_criterion[*].status is "implemented"
#       * quality_gate_failures is empty (hollow-success quality-gate branch
#         still applies; the unverified-result branch is exempt for the
#         execute phase since the executor always emits unverified results)
#   - execution.changes_by_criterion[*].files_touched MUST be a subset of
#     the top-level changed_files
#
# jq-only — no node/python — matching scripts/validate-afk-task-contract.sh
# and scripts/validate-issue-analyzer-contract.sh so the release pipeline
# does not need new dependencies.
#
# Usage:
#   scripts/validate-task-executor-contract.sh <path/to/envelope.json> [<more.json> …]

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

# Schema-level constants must stay in sync with task-executor.schema.json.
REQUIRED_KEYS=(
  status phase runner issue_number scope_summary
  non_goals acceptance_criteria_results changed_files
  verification_commands verification_results quality_gate_failures
  blocker_reason next_human_action remaining_risks
  confidence raw_runner_output_path execution
)
EXECUTION_REQUIRED_KEYS=(
  implementation_summary changes_by_criterion out_of_scope_rejections
  non_goals_preserved commit_hint escalation_triggers follow_ups
)
STATUS_ENUM='completed blocked escalation_needed'
RUNNER_ENUM='claude codex hermes'
CONFIDENCE_ENUM='low medium high'
CHANGE_STATUS_ENUM='implemented partial deferred'

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

  if ! jq -e 'type == "object"' "$file" >/dev/null 2>&1; then
    if ! jq -e . "$file" >/dev/null 2>&1; then
      fail "$file" "malformed JSON (did not parse)"
    fi
    fail "$file" "malformed JSON (root must be an object)"
  fi

  local key
  for key in "${REQUIRED_KEYS[@]}"; do
    jq -e --arg k "$key" 'has($k)' "$file" >/dev/null \
      || fail "$file" "missing required field: $key"
  done

  local status phase runner confidence
  status=$(jq -r '.status' "$file")
  phase=$(jq -r '.phase' "$file")
  runner=$(jq -r '.runner' "$file")
  confidence=$(jq -r '.confidence' "$file")

  in_enum "$status"     "$STATUS_ENUM"     || fail "$file" "status not in {$STATUS_ENUM}: $status"
  in_enum "$runner"     "$RUNNER_ENUM"     || fail "$file" "runner not in {$RUNNER_ENUM}: $runner"
  in_enum "$confidence" "$CONFIDENCE_ENUM" || fail "$file" "confidence not in {$CONFIDENCE_ENUM}: $confidence"

  [ "$phase" = "execute_task" ] \
    || fail "$file" "phase must be 'execute_task' for task-executor envelopes: $phase"

  jq -e '.issue_number | type == "number" and . == (. | floor) and . >= 1' "$file" >/dev/null \
    || fail "$file" "issue_number must be a positive integer"

  jq -e '.scope_summary | type == "string" and length > 0' "$file" >/dev/null \
    || fail "$file" "scope_summary must be a non-empty string"

  local arr
  for arr in non_goals acceptance_criteria_results changed_files \
             verification_commands verification_results \
             quality_gate_failures remaining_risks; do
    jq -e --arg k "$arr" '.[$k] | type == "array"' "$file" >/dev/null \
      || fail "$file" "$arr must be an array (use [] for empty)"
  done

  # Execute-phase invariants: these arrays must be empty here.
  for arr in verification_commands verification_results quality_gate_failures; do
    jq -e --arg k "$arr" '.[$k] | length == 0' "$file" >/dev/null \
      || fail "$file" "$arr must be empty in the execute_task phase"
  done

  jq -e '
    .changed_files | all(type == "string" and length > 0)
  ' "$file" >/dev/null \
    || fail "$file" "changed_files items must be non-empty strings"

  jq -e '
    .acceptance_criteria_results
    | all(
        type == "object"
        and (has("criterion") and (.criterion | type == "string" and length > 0))
        and (has("result")    and (.result    | . == "unverified"))
        and (has("evidence")  and (.evidence  | type == "string"))
      )
  ' "$file" >/dev/null \
    || fail "$file" "acceptance_criteria_results items must be {criterion, result=='unverified', evidence} in the execute_task phase"

  local nfield
  for nfield in blocker_reason next_human_action raw_runner_output_path; do
    jq -e --arg k "$nfield" '.[$k] | (type == "string" or . == null)' "$file" >/dev/null \
      || fail "$file" "$nfield must be a string or null"
  done

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

  # execution object
  jq -e '.execution | type == "object"' "$file" >/dev/null \
    || fail "$file" "execution must be an object"

  local ekey
  for ekey in "${EXECUTION_REQUIRED_KEYS[@]}"; do
    jq -e --arg k "$ekey" '.execution | has($k)' "$file" >/dev/null \
      || fail "$file" "execution missing required field: $ekey"
  done

  jq -e '.execution.implementation_summary | type == "string" and length > 0' "$file" >/dev/null \
    || fail "$file" "execution.implementation_summary must be a non-empty string"

  local earr
  for earr in changes_by_criterion out_of_scope_rejections non_goals_preserved \
              escalation_triggers follow_ups; do
    jq -e --arg k "$earr" '.execution[$k] | type == "array"' "$file" >/dev/null \
      || fail "$file" "execution.$earr must be an array (use [] for empty)"
  done

  jq -e '
    .execution.changes_by_criterion
    | all(
        type == "object"
        and (has("criterion") and (.criterion | type == "string" and length > 0))
        and (has("files_touched") and (.files_touched | type == "array" and all(type == "string" and length > 0)))
        and (has("approach")  and (.approach  | type == "string" and length > 0))
        and (has("status")    and (.status    | type == "string"))
      )
  ' "$file" >/dev/null \
    || fail "$file" "execution.changes_by_criterion items must be {criterion, files_touched, approach, status}"

  # changes_by_criterion[*].status must be in CHANGE_STATUS_ENUM
  local change_status
  while IFS= read -r change_status; do
    [ -n "$change_status" ] || continue
    in_enum "$change_status" "$CHANGE_STATUS_ENUM" \
      || fail "$file" "execution.changes_by_criterion[*].status not in {$CHANGE_STATUS_ENUM}: $change_status"
  done < <(jq -r '.execution.changes_by_criterion[].status' "$file")

  # files_touched must be a subset of top-level changed_files
  jq -e '
    (.changed_files // []) as $cf
    | .execution.changes_by_criterion
    | all(.files_touched | all(. as $f | $cf | index($f) != null))
  ' "$file" >/dev/null \
    || fail "$file" "execution.changes_by_criterion[*].files_touched must be a subset of changed_files"

  jq -e '
    .execution.out_of_scope_rejections
    | all(
        type == "object"
        and (has("requested_change") and (.requested_change | type == "string" and length > 0))
        and (has("reason")           and (.reason           | type == "string" and length > 0))
      )
  ' "$file" >/dev/null \
    || fail "$file" "execution.out_of_scope_rejections items must be {requested_change, reason} with non-empty strings"

  jq -e '
    .execution.commit_hint == null
    or (
      .execution.commit_hint | type == "object"
      and (has("subject") and (.subject | type == "string" and length > 0))
      and (has("body")    and (.body    | type == "string"))
    )
  ' "$file" >/dev/null \
    || fail "$file" "execution.commit_hint must be null or {subject (non-empty), body}"

  jq -e '.execution.escalation_triggers | all(type == "string" and length > 0)' "$file" >/dev/null \
    || fail "$file" "execution.escalation_triggers items must be non-empty strings"

  jq -e '.execution.follow_ups | all(type == "string" and length > 0)' "$file" >/dev/null \
    || fail "$file" "execution.follow_ups items must be non-empty strings"

  # Completed-status invariants for the execute phase.
  if [ "$status" = "completed" ]; then
    if jq -e '.changed_files | length == 0' "$file" >/dev/null; then
      fail "$file" "hollow completion: status=completed with empty changed_files"
    fi
    if jq -e '.quality_gate_failures | length > 0' "$file" >/dev/null; then
      fail "$file" "hollow success: status=completed with non-empty quality_gate_failures"
    fi
    if jq -e '.execution.changes_by_criterion | any(.status != "implemented")' "$file" >/dev/null; then
      fail "$file" "status=completed requires every execution.changes_by_criterion[*].status to be 'implemented'"
    fi
  fi
}

for arg in "$@"; do
  validate_file "$arg"
done

printf 'ok: %d task-executor envelope(s) valid\n' "$#"
