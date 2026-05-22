#!/usr/bin/env bash
# Contract tests for the runner-portable fleet wrapper documented in SKILL.md
# and ADR 0015. The wrapper is agent-driven, so these checks pin the text that
# future agents execute.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../../../../../.." && pwd)"
SKILL="$ROOT/plugins/dev/skills/engineering/afk/SKILL.md"
README="$ROOT/README.md"
ADR="$ROOT/.red/adr/0015-fleet-supervisor-is-runner-portable.md"
CONTEXT="$ROOT/.red/CONTEXT.md"

pass=0
fail=0

ok()  { echo "PASS  $1"; pass=$((pass + 1)); }
bad() { echo "FAIL  $1"; fail=$((fail + 1)); }

expect_contains() {
  local label="$1" file="$2" needle="$3"
  if grep -Fq -- "$needle" "$file"; then
    ok "$label"
  else
    bad "$label"
    printf '  missing in %s: %s\n' "$file" "$needle"
  fi
}

expect_absent() {
  local label="$1" file="$2" needle="$3"
  if grep -Fq -- "$needle" "$file"; then
    bad "$label"
    printf '  unexpected in %s: %s\n' "$file" "$needle"
  else
    ok "$label"
  fi
}

expect_contains "skill: fleet mode is runner-portable" \
  "$SKILL" "## Fleet Mode (runner-portable"
expect_absent "skill: no Codex launch refusal" \
  "$SKILL" "fleet mode is not supported under Codex"
expect_contains "skill: Codex launch pins runner" \
  "$SKILL" 'Under Codex, this must be `RED_AFK_RUNNER=codex`.'
expect_contains "skill: supervisor spawn carries runner" \
  "$SKILL" "RED_AFK_TARGET=<N> RED_AFK_RUNNER=<runner>"
expect_contains "skill: Codex monitor agent is read-only" \
  "$SKILL" "spawn exactly one read-only Codex monitor agent"
expect_contains "skill: stop is portable" \
  "$SKILL" "Codex monitor agent will self-close when it observes fleet stopped."

expect_contains "ADR: records runner-portable supervisor" \
  "$ADR" "The **Fleet supervisor is runner-portable**."
expect_contains "ADR: records Codex monitor agent" \
  "$ADR" "read-only Codex monitor agent"

expect_contains "context: defines Fleet supervisor" \
  "$CONTEXT" "**Fleet supervisor**:"
expect_contains "context: defines Codex monitor agent" \
  "$CONTEXT" "**Codex monitor agent**:"

expect_contains "README: says fleet supervisor is runner-portable" \
  "$README" "one runner-portable supervisor"
expect_contains "README: documents Codex monitor fallback" \
  "$README" "Under Codex, fleet launches the same supervisor"

echo
echo "summary: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
