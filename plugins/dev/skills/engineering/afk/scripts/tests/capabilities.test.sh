#!/usr/bin/env bash
# Unit tests for lib/capabilities.sh — the capability probe and run-mode
# dispatch introduced for #202.
#
# The lib is source-only; these tests call its functions directly with the
# CAPABILITIES_AGENTS_DIR / CAPABILITIES_CODEX_PHASE_DIR overrides so the
# probe is hermetic — never reads the real plugin tree, never spawns claude
# or codex.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LIB="$HERE/../lib/capabilities.sh"

# shellcheck disable=SC1090
source "$LIB"

pass=0
fail=0

expect_eq() {
  local label="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    echo "PASS  $label"
    pass=$((pass + 1))
  else
    echo "FAIL  $label"
    echo "  got:  >>$got<<"
    echo "  want: >>$want<<"
    fail=$((fail + 1))
  fi
}

# Wipe env knobs every test reads.
unset RED_AFK_RUN_MODE RED_AFK_RUNNER_HAS_JSON

# Pretend git worktree always exists so the probe is host-independent.
export CAPABILITIES_HAS_WORKTREE=1

# Empty agents dir → claude lacks native_agents.
empty_dir="$(mktemp -d)"
export CAPABILITIES_AGENTS_DIR="$empty_dir"
export CAPABILITIES_CODEX_PHASE_DIR="$empty_dir"

caps_claude="$(capabilities_detect claude)"
expect_eq "claude native=0 when agents/ empty"    "$(grep -c '^native_agents=0$'    <<<"$caps_claude")" "1"
expect_eq "claude structured=1"                   "$(grep -c '^structured_output=1$' <<<"$caps_claude")" "1"
expect_eq "claude resume=1"                       "$(grep -c '^resume_session=1$'    <<<"$caps_claude")" "1"
expect_eq "claude worktree=1"                     "$(grep -c '^worktree_support=1$'  <<<"$caps_claude")" "1"
expect_eq "claude hooks=1"                        "$(grep -c '^hooks_events=1$'      <<<"$caps_claude")" "1"
expect_eq "claude perm=1"                         "$(grep -c '^permission_modes=1$'  <<<"$caps_claude")" "1"

caps_codex="$(capabilities_detect codex)"
expect_eq "codex native=0 (no native sub-agent surface today)" \
                                                  "$(grep -c '^native_agents=0$'    <<<"$caps_codex")"  "1"
expect_eq "codex structured=1"                    "$(grep -c '^structured_output=1$' <<<"$caps_codex")"  "1"
expect_eq "codex resume=0"                        "$(grep -c '^resume_session=0$'    <<<"$caps_codex")"  "1"
expect_eq "codex phased=0 when phases/codex empty" "$(grep -c '^phased_mode=0$'      <<<"$caps_codex")"  "1"

# Mode selection on the empty probe — both runners drop to *-basic.
mode_claude="$(capabilities_select_mode claude $caps_claude)"
expect_eq "claude → claude-basic when no agents" "$mode_claude" "claude-basic"

mode_codex="$(capabilities_select_mode codex $caps_codex)"
expect_eq "codex  → codex-basic when no phases" "$mode_codex" "codex-basic"

# Full agents dir → claude promotes to claude-native.
agents_dir="$(mktemp -d)"
: >"$agents_dir/issue-analyzer.md"
: >"$agents_dir/task-executor.md"
: >"$agents_dir/quality-gate.md"
export CAPABILITIES_AGENTS_DIR="$agents_dir"
caps_full="$(capabilities_detect claude)"
mode_full="$(capabilities_select_mode claude $caps_full)"
expect_eq "claude → claude-native when 3 agents present" "$mode_full" "claude-native"

# Partial agents dir → degrades back to basic. A half-native dispatch is
# refused on purpose: missing one phase means downstream wiring is broken.
rm -f "$agents_dir/quality-gate.md"
caps_partial="$(capabilities_detect claude)"
mode_partial="$(capabilities_select_mode claude $caps_partial)"
expect_eq "claude → claude-basic when one agent missing" "$mode_partial" "claude-basic"

# Reset to empty for the codex phase test.
export CAPABILITIES_AGENTS_DIR="$empty_dir"

# Codex phase prompts present → codex-phased.
phase_dir="$(mktemp -d)"
: >"$phase_dir/analyze.md"
: >"$phase_dir/verify.md"
: >"$phase_dir/finalize.md"
export CAPABILITIES_CODEX_PHASE_DIR="$phase_dir"
caps_codex_full="$(capabilities_detect codex)"
mode_codex_full="$(capabilities_select_mode codex $caps_codex_full)"
expect_eq "codex → codex-phased when phase prompts shipped" "$mode_codex_full" "codex-phased"

rm -f "$phase_dir/finalize.md"
caps_codex_partial="$(capabilities_detect codex)"
mode_codex_partial="$(capabilities_select_mode codex $caps_codex_partial)"
expect_eq "codex → codex-basic when one phase prompt missing" "$mode_codex_partial" "codex-basic"

# Unknown runner → hermes-fallback regardless of probes.
caps_unknown="$(capabilities_detect hermes)"
mode_unknown="$(capabilities_select_mode hermes $caps_unknown)"
expect_eq "unknown runner → hermes-fallback" "$mode_unknown" "hermes-fallback"

# Operator override: RED_AFK_RUN_MODE=basic forces *-basic.
export CAPABILITIES_AGENTS_DIR="$agents_dir"
: >"$agents_dir/quality-gate.md"
caps_for_override="$(capabilities_detect claude)"
RED_AFK_RUN_MODE=basic mode_override="$(RED_AFK_RUN_MODE=basic capabilities_select_mode claude $caps_for_override)"
expect_eq "RED_AFK_RUN_MODE=basic forces claude-basic" "$mode_override" "claude-basic"

# RED_AFK_RUN_MODE=fallback always picks hermes-fallback.
mode_force_fallback="$(RED_AFK_RUN_MODE=fallback capabilities_select_mode claude $caps_for_override)"
expect_eq "RED_AFK_RUN_MODE=fallback forces hermes-fallback" "$mode_force_fallback" "hermes-fallback"

# RED_AFK_RUN_MODE=native is honoured only when the env can satisfy it. The
# claude probe above has all three agents, so it's allowed.
mode_force_native="$(RED_AFK_RUN_MODE=native capabilities_select_mode claude $caps_for_override)"
expect_eq "RED_AFK_RUN_MODE=native promotes when available" "$mode_force_native" "claude-native"

# When env *cannot* satisfy native, RED_AFK_RUN_MODE=native is ignored and
# auto-selection takes over (codex falls through to its own auto branch).
mode_native_on_codex="$(RED_AFK_RUN_MODE=native capabilities_select_mode codex $caps_codex)"
expect_eq "RED_AFK_RUN_MODE=native ignored on codex (auto kicks in)" "$mode_native_on_codex" "codex-basic"

# capabilities_dispatch_log: one line, deterministic shape.
log_line="$(capabilities_dispatch_log claude claude-basic native_agents=0 structured_output=1)"
expect_eq "dispatch_log shape" "$log_line" \
  "dispatch: runner=claude mode=claude-basic native_agents=0 structured_output=1"

# Cleanup.
rm -rf "$empty_dir" "$agents_dir" "$phase_dir"

echo
echo "summary: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
