#!/usr/bin/env bash
# Validate an AFK issue-analyzer envelope against
# .red/contracts/issue-analyzer.schema.json.
#
# The issue-analyzer envelope is the analyze_issue specialization of the base
# AFK task envelope (see scripts/validate-afk-task-contract.sh): the base
# fields are validated identically, plus the analyze-phase invariants below
# and the analyzer-specific `analysis` object.
#
# Analyze-phase invariants enforced here:
#   - phase MUST equal "analyze_issue"
#   - changed_files, verification_commands, verification_results,
#     quality_gate_failures MUST all be empty arrays (the analyzer has not
#     executed or verified anything yet)
#   - every acceptance_criteria_results[*].result MUST be "unverified" (the
#     analyzer mirrors the brief's checklist; it never grades)
#   - analysis.task_type == "unknown" requires status in {blocked, escalation_needed}
#   - analysis.ambiguity_score == "high" requires status in {blocked, escalation_needed}
#     AND analysis.open_questions to be non-empty
#   - the hollow-success rule for quality_gate_failures still applies; the
#     unverified-result branch is intentionally not applied here because the
#     analyze phase requires unverified results.
#
# jq-only — no node/python — matching scripts/validate-afk-task-contract.sh
# so the release pipeline does not need new dependencies.
#
# Usage:
#   scripts/validate-issue-analyzer-contract.sh <path/to/envelope.json> [<more.json> …]

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

# Schema-level constants must stay in sync with issue-analyzer.schema.json.
REQUIRED_KEYS=(
  status phase runner issue_number scope_summary
  non_goals acceptance_criteria_results changed_files
  verification_commands verification_results quality_gate_failures
  blocker_reason next_human_action remaining_risks
  confidence raw_runner_output_path analysis
)
ANALYSIS_REQUIRED_KEYS=(
  task_type affected_area recommended_skills risk_level
  scope_boundaries acceptance_criteria_map verification_expectations
  open_questions ambiguity_score
)
STATUS_ENUM='completed blocked escalation_needed'
RUNNER_ENUM='claude codex hermes'
CONFIDENCE_ENUM='low medium high'
RISK_ENUM='low medium high'
AMBIGUITY_ENUM='low medium high'
TASK_TYPE_ENUM='feature bug_fix refactor docs chore test contract infra unknown'

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

  [ "$phase" = "analyze_issue" ] \
    || fail "$file" "phase must be 'analyze_issue' for issue-analyzer envelopes: $phase"

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

  # Analyze-phase invariants: these arrays must be empty here.
  for arr in changed_files verification_commands verification_results quality_gate_failures; do
    jq -e --arg k "$arr" '.[$k] | length == 0' "$file" >/dev/null \
      || fail "$file" "$arr must be empty in the analyze_issue phase"
  done

  jq -e '
    .acceptance_criteria_results
    | all(
        type == "object"
        and (has("criterion") and (.criterion | type == "string" and length > 0))
        and (has("result")    and (.result    | . == "unverified"))
        and (has("evidence")  and (.evidence  | type == "string"))
      )
  ' "$file" >/dev/null \
    || fail "$file" "acceptance_criteria_results items must be {criterion, result=='unverified', evidence} in the analyze_issue phase"

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

  # analysis object
  jq -e '.analysis | type == "object"' "$file" >/dev/null \
    || fail "$file" "analysis must be an object"

  local akey
  for akey in "${ANALYSIS_REQUIRED_KEYS[@]}"; do
    jq -e --arg k "$akey" '.analysis | has($k)' "$file" >/dev/null \
      || fail "$file" "analysis missing required field: $akey"
  done

  local task_type risk_level ambiguity_score
  task_type=$(jq -r '.analysis.task_type' "$file")
  risk_level=$(jq -r '.analysis.risk_level' "$file")
  ambiguity_score=$(jq -r '.analysis.ambiguity_score' "$file")

  in_enum "$task_type"       "$TASK_TYPE_ENUM"  || fail "$file" "analysis.task_type not in {$TASK_TYPE_ENUM}: $task_type"
  in_enum "$risk_level"      "$RISK_ENUM"       || fail "$file" "analysis.risk_level not in {$RISK_ENUM}: $risk_level"
  in_enum "$ambiguity_score" "$AMBIGUITY_ENUM"  || fail "$file" "analysis.ambiguity_score not in {$AMBIGUITY_ENUM}: $ambiguity_score"

  jq -e '.analysis.affected_area | type == "string" and length > 0' "$file" >/dev/null \
    || fail "$file" "analysis.affected_area must be a non-empty string"

  local aarr
  for aarr in recommended_skills scope_boundaries acceptance_criteria_map \
              verification_expectations open_questions; do
    jq -e --arg k "$aarr" '.analysis[$k] | type == "array"' "$file" >/dev/null \
      || fail "$file" "analysis.$aarr must be an array (use [] for empty)"
  done

  jq -e '.analysis.scope_boundaries | length >= 1 and all(type == "string" and length > 0)' "$file" >/dev/null \
    || fail "$file" "analysis.scope_boundaries must be a non-empty array of non-empty strings"

  jq -e '
    .analysis.acceptance_criteria_map
    | all(
        type == "object"
        and (has("criterion")    and (.criterion    | type == "string" and length > 0))
        and (has("plan")         and (.plan         | type == "string" and length > 0))
        and (has("verification") and (.verification | type == "string" and length > 0))
      )
  ' "$file" >/dev/null \
    || fail "$file" "analysis.acceptance_criteria_map items must be {criterion, plan, verification} with non-empty strings"

  jq -e '.analysis.verification_expectations | all(type == "string" and length > 0)' "$file" >/dev/null \
    || fail "$file" "analysis.verification_expectations items must be non-empty strings"

  # cross-field invariants
  if [ "$task_type" = "unknown" ] && [ "$status" = "completed" ]; then
    fail "$file" "analysis.task_type='unknown' requires status in {blocked, escalation_needed}"
  fi

  if [ "$ambiguity_score" = "high" ]; then
    if [ "$status" = "completed" ]; then
      fail "$file" "analysis.ambiguity_score='high' requires status in {blocked, escalation_needed}"
    fi
    jq -e '.analysis.open_questions | length >= 1' "$file" >/dev/null \
      || fail "$file" "analysis.ambiguity_score='high' requires at least one analysis.open_questions entry"
  fi

  # hollow-success (quality-gate branch only; the unverified branch is exempt
  # for analyze_issue since the analyzer always emits unverified results).
  if [ "$status" = "completed" ]; then
    if jq -e '.quality_gate_failures | length > 0' "$file" >/dev/null; then
      fail "$file" "hollow success: status=completed with non-empty quality_gate_failures"
    fi
  fi
}

for arg in "$@"; do
  validate_file "$arg"
done

printf 'ok: %d issue-analyzer envelope(s) valid\n' "$#"
