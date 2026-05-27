#!/usr/bin/env bash
# Validate an AFK quality-gate envelope against
# .red/contracts/quality-gate.schema.json.
#
# The quality-gate envelope is the verify_task specialization of the base
# AFK task envelope (see scripts/validate-afk-task-contract.sh): the base
# fields are validated identically, plus the verify-phase invariants below
# and the gate-specific `quality_gate` object.
#
# Verify-phase invariants enforced here:
#   - phase MUST equal "verify_task"
#   - acceptance_criteria_results[*].result MUST be in {pass, fail, unverified}
#   - verification_commands, verification_results, and quality_gate.checks_run
#     MUST be the same length, and entry i of verification_results /
#     checks_run MUST quote verification_commands[i] as its `command`
#   - quality_gate.outcome semantics:
#       * approved  -> status == completed,
#                      every acceptance result == "pass",
#                      quality_gate_failures == [],
#                      stub_findings == [],
#                      scope_drift_findings == []
#       * blocked   -> status in {blocked, escalation_needed}
#       * stub_detected -> status in {blocked, escalation_needed} and
#                          stub_findings non-empty and next_human_action set
#
# jq-only — no node/python — matching the other AFK contract validators so
# the release pipeline does not need new dependencies.
#
# Usage:
#   scripts/validate-quality-gate-contract.sh <path/to/envelope.json> [<more.json> …]

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

REQUIRED_KEYS=(
  status phase runner issue_number scope_summary
  non_goals acceptance_criteria_results changed_files
  verification_commands verification_results quality_gate_failures
  blocker_reason next_human_action remaining_risks
  confidence raw_runner_output_path quality_gate
)
QUALITY_GATE_REQUIRED_KEYS=(
  outcome checks_run discovered_commands stub_findings
  scope_drift_findings acceptance_verification
  fixes_applied fixes_rejected rtk_used
)
STATUS_ENUM='completed blocked escalation_needed'
RUNNER_ENUM='claude codex hermes'
CONFIDENCE_ENUM='low medium high'
RESULT_ENUM='pass fail unverified'
OUTCOME_ENUM='approved blocked stub_detected'
STUB_KIND_ENUM='skipped_test hollow_test zero_test_match placeholder_implementation'
VERIFIED_ENUM='by_command by_artifact unverifiable_in_this_phase human_override'

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

  local status phase runner confidence outcome
  status=$(jq -r '.status' "$file")
  phase=$(jq -r '.phase' "$file")
  runner=$(jq -r '.runner' "$file")
  confidence=$(jq -r '.confidence' "$file")

  in_enum "$status"     "$STATUS_ENUM"     || fail "$file" "status not in {$STATUS_ENUM}: $status"
  in_enum "$runner"     "$RUNNER_ENUM"     || fail "$file" "runner not in {$RUNNER_ENUM}: $runner"
  in_enum "$confidence" "$CONFIDENCE_ENUM" || fail "$file" "confidence not in {$CONFIDENCE_ENUM}: $confidence"

  [ "$phase" = "verify_task" ] \
    || fail "$file" "phase must be 'verify_task' for quality-gate envelopes: $phase"

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

  jq -e '
    .changed_files | all(type == "string" and length > 0)
  ' "$file" >/dev/null \
    || fail "$file" "changed_files items must be non-empty strings"

  jq -e '
    .verification_commands | all(type == "string" and length > 0)
  ' "$file" >/dev/null \
    || fail "$file" "verification_commands items must be non-empty strings"

  jq -e '
    .quality_gate_failures | all(type == "string" and length > 0)
  ' "$file" >/dev/null \
    || fail "$file" "quality_gate_failures items must be non-empty strings"

  jq -e '
    .verification_results
    | all(
        type == "object"
        and (has("command")   and (.command   | type == "string" and length > 0))
        and (has("exit_code") and (.exit_code | type == "number" and . == (. | floor)))
        and (has("summary")   and (.summary   | type == "string"))
      )
  ' "$file" >/dev/null \
    || fail "$file" "verification_results items must be {command, exit_code:int, summary}"

  jq -e '
    .acceptance_criteria_results
    | all(
        type == "object"
        and (has("criterion") and (.criterion | type == "string" and length > 0))
        and (has("result")    and (.result    | type == "string"))
        and (has("evidence")  and (.evidence  | type == "string"))
      )
  ' "$file" >/dev/null \
    || fail "$file" "acceptance_criteria_results items must be {criterion, result, evidence}"

  local result
  while IFS= read -r result; do
    [ -n "$result" ] || continue
    in_enum "$result" "$RESULT_ENUM" \
      || fail "$file" "acceptance_criteria_results[*].result not in {$RESULT_ENUM}: $result"
  done < <(jq -r '.acceptance_criteria_results[].result' "$file")

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

  # verification_commands and verification_results must agree.
  local vc_len vr_len cr_len
  vc_len=$(jq '.verification_commands | length' "$file")
  vr_len=$(jq '.verification_results  | length' "$file")
  [ "$vc_len" = "$vr_len" ] \
    || fail "$file" "verification_commands ($vc_len) and verification_results ($vr_len) must have the same length"

  jq -e '
    [.verification_commands, [.verification_results[].command]]
    | .[0] == .[1]
  ' "$file" >/dev/null \
    || fail "$file" "verification_results[*].command must equal verification_commands[*] in order"

  # quality_gate object
  jq -e '.quality_gate | type == "object"' "$file" >/dev/null \
    || fail "$file" "quality_gate must be an object"

  local qkey
  for qkey in "${QUALITY_GATE_REQUIRED_KEYS[@]}"; do
    jq -e --arg k "$qkey" '.quality_gate | has($k)' "$file" >/dev/null \
      || fail "$file" "quality_gate missing required field: $qkey"
  done

  outcome=$(jq -r '.quality_gate.outcome' "$file")
  in_enum "$outcome" "$OUTCOME_ENUM" \
    || fail "$file" "quality_gate.outcome not in {$OUTCOME_ENUM}: $outcome"

  local qarr
  for qarr in checks_run discovered_commands stub_findings scope_drift_findings \
              acceptance_verification fixes_applied fixes_rejected; do
    jq -e --arg k "$qarr" '.quality_gate[$k] | type == "array"' "$file" >/dev/null \
      || fail "$file" "quality_gate.$qarr must be an array (use [] for empty)"
  done

  jq -e '.quality_gate.rtk_used | type == "boolean"' "$file" >/dev/null \
    || fail "$file" "quality_gate.rtk_used must be a boolean"

  jq -e '
    .quality_gate.checks_run
    | all(
        type == "object"
        and (has("name")             and (.name             | type == "string" and length > 0))
        and (has("command")          and (.command          | type == "string" and length > 0))
        and (has("exit_code")        and (.exit_code        | type == "number" and . == (. | floor)))
        and (has("duration_seconds") and (.duration_seconds | type == "number" and . >= 0))
        and (has("output_summary")   and (.output_summary   | type == "string"))
        and (has("used_rtk")         and (.used_rtk         | type == "boolean"))
      )
  ' "$file" >/dev/null \
    || fail "$file" "quality_gate.checks_run items must be {name, command, exit_code, duration_seconds, output_summary, used_rtk}"

  cr_len=$(jq '.quality_gate.checks_run | length' "$file")
  [ "$cr_len" = "$vc_len" ] \
    || fail "$file" "quality_gate.checks_run ($cr_len) and verification_commands ($vc_len) must have the same length"

  jq -e '
    [.verification_commands, [.quality_gate.checks_run[].command]]
    | .[0] == .[1]
  ' "$file" >/dev/null \
    || fail "$file" "quality_gate.checks_run[*].command must equal verification_commands[*] in order"

  jq -e '
    [[.verification_results[].exit_code], [.quality_gate.checks_run[].exit_code]]
    | .[0] == .[1]
  ' "$file" >/dev/null \
    || fail "$file" "quality_gate.checks_run[*].exit_code must equal verification_results[*].exit_code in order"

  jq -e '
    .quality_gate.discovered_commands
    | all(
        type == "object"
        and (has("name")            and (.name | type == "string" and length > 0))
        and (has("command")         and (.command | type == "string" and length > 0))
        and (has("reason_included") and (.reason_included | (type == "string" or . == null)))
        and (has("reason_skipped")  and (.reason_skipped  | (type == "string" or . == null)))
      )
  ' "$file" >/dev/null \
    || fail "$file" "quality_gate.discovered_commands items malformed"

  jq -e '
    .quality_gate.stub_findings
    | all(
        type == "object"
        and (has("kind")     and (.kind     | type == "string"))
        and (has("location") and (.location | type == "string" and length > 0))
        and (has("evidence") and (.evidence | type == "string" and length > 0))
      )
  ' "$file" >/dev/null \
    || fail "$file" "quality_gate.stub_findings items must be {kind, location, evidence}"

  local skind
  while IFS= read -r skind; do
    [ -n "$skind" ] || continue
    in_enum "$skind" "$STUB_KIND_ENUM" \
      || fail "$file" "quality_gate.stub_findings[*].kind not in {$STUB_KIND_ENUM}: $skind"
  done < <(jq -r '.quality_gate.stub_findings[].kind' "$file")

  jq -e '
    .quality_gate.scope_drift_findings
    | all(
        type == "object"
        and (has("file")   and (.file   | type == "string" and length > 0))
        and (has("reason") and (.reason | type == "string" and length > 0))
      )
  ' "$file" >/dev/null \
    || fail "$file" "quality_gate.scope_drift_findings items must be {file, reason}"

  jq -e '
    .quality_gate.acceptance_verification
    | all(
        type == "object"
        and (has("criterion")       and (.criterion | type == "string" and length > 0))
        and (has("verified")        and (.verified  | type == "string"))
        and (has("evidence_source") and (.evidence_source | type == "string" and length > 0))
      )
  ' "$file" >/dev/null \
    || fail "$file" "quality_gate.acceptance_verification items must be {criterion, verified, evidence_source}"

  local vtag
  while IFS= read -r vtag; do
    [ -n "$vtag" ] || continue
    in_enum "$vtag" "$VERIFIED_ENUM" \
      || fail "$file" "quality_gate.acceptance_verification[*].verified not in {$VERIFIED_ENUM}: $vtag"
  done < <(jq -r '.quality_gate.acceptance_verification[].verified' "$file")

  jq -e '
    .quality_gate.fixes_applied
    | all(
        type == "object"
        and (has("file")                  and (.file | type == "string" and length > 0))
        and (has("description")           and (.description | type == "string" and length > 0))
        and (has("in_scope_justification") and (.in_scope_justification | type == "string" and length > 0))
      )
  ' "$file" >/dev/null \
    || fail "$file" "quality_gate.fixes_applied items must be {file, description, in_scope_justification}"

  jq -e '
    .quality_gate.fixes_rejected
    | all(
        type == "object"
        and (has("requested_fix") and (.requested_fix | type == "string" and length > 0))
        and (has("reason")        and (.reason        | type == "string" and length > 0))
      )
  ' "$file" >/dev/null \
    || fail "$file" "quality_gate.fixes_rejected items must be {requested_fix, reason}"

  # Outcome-vs-envelope invariants.
  case "$outcome" in
    approved)
      [ "$status" = "completed" ] \
        || fail "$file" "quality_gate.outcome=approved requires status=completed (got $status)"
      if jq -e '.quality_gate_failures | length > 0' "$file" >/dev/null; then
        fail "$file" "quality_gate.outcome=approved requires empty quality_gate_failures"
      fi
      if jq -e '.acceptance_criteria_results | any(.result != "pass")' "$file" >/dev/null; then
        fail "$file" "quality_gate.outcome=approved requires every acceptance_criteria_results[*].result to be 'pass'"
      fi
      if jq -e '.quality_gate.stub_findings | length > 0' "$file" >/dev/null; then
        fail "$file" "quality_gate.outcome=approved forbids non-empty stub_findings"
      fi
      if jq -e '.quality_gate.scope_drift_findings | length > 0' "$file" >/dev/null; then
        fail "$file" "quality_gate.outcome=approved forbids non-empty scope_drift_findings"
      fi
      ;;
    blocked)
      case "$status" in
        blocked|escalation_needed) ;;
        *) fail "$file" "quality_gate.outcome=blocked requires status in {blocked, escalation_needed} (got $status)" ;;
      esac
      ;;
    stub_detected)
      case "$status" in
        blocked|escalation_needed) ;;
        *) fail "$file" "quality_gate.outcome=stub_detected requires status in {blocked, escalation_needed} (got $status)" ;;
      esac
      if jq -e '.quality_gate.stub_findings | length == 0' "$file" >/dev/null; then
        fail "$file" "quality_gate.outcome=stub_detected requires at least one stub_findings entry"
      fi
      jq -e '.next_human_action | type == "string" and length > 0' "$file" >/dev/null \
        || fail "$file" "quality_gate.outcome=stub_detected requires non-empty next_human_action"
      ;;
  esac

  # Base envelope hollow-success rule, repeated here so consumers do not
  # have to chain validators.
  if [ "$status" = "completed" ]; then
    if jq -e '.quality_gate_failures | length > 0' "$file" >/dev/null; then
      fail "$file" "hollow success: status=completed with non-empty quality_gate_failures"
    fi
    if jq -e '.acceptance_criteria_results | any(.result != "pass")' "$file" >/dev/null; then
      fail "$file" "hollow success: status=completed with non-passing acceptance_criteria_results"
    fi
  fi
}

for arg in "$@"; do
  validate_file "$arg"
done

printf 'ok: %d quality-gate envelope(s) valid\n' "$#"
