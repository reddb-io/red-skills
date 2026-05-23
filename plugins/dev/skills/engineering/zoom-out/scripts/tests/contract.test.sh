#!/usr/bin/env bash
# Contract test for the zoom-out SKILL.md.
#
# Asserts the Answer Contract carries an optional Impact section between
# Relationships and Critical Paths, defines structural impact in the
# expected terms, requires graph evidence be interpreted (not pasted raw),
# stays read-only, and does not introduce a new /impact skill or a
# memory_impact primitive (issue #97, parent #95).

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SKILL_MD="$HERE/../../SKILL.md"

if [ ! -f "$SKILL_MD" ]; then
  echo "FAIL  SKILL.md not found at $SKILL_MD" >&2
  exit 1
fi

pass=0
fail=0

# absent(needle): assert the literal string does NOT appear anywhere in SKILL.md.
absent() {
  local label="$1" needle="$2"
  if grep -qF "$needle" "$SKILL_MD"; then
    echo "FAIL  $label (forbidden text present: $needle)" >&2
    fail=$((fail + 1))
  else
    echo "ok    $label"
    pass=$((pass + 1))
  fi
}

# present(needle): assert the literal string DOES appear.
present() {
  local label="$1" needle="$2"
  if grep -qF "$needle" "$SKILL_MD"; then
    echo "ok    $label"
    pass=$((pass + 1))
  else
    echo "FAIL  $label (missing: $needle)" >&2
    fail=$((fail + 1))
  fi
}

# present_re(regex): assert the extended regex matches.
present_re() {
  local label="$1" re="$2"
  if grep -Eq "$re" "$SKILL_MD"; then
    echo "ok    $label"
    pass=$((pass + 1))
  else
    echo "FAIL  $label (regex did not match: $re)" >&2
    fail=$((fail + 1))
  fi
}

# --- Section order: Relationships -> Impact -> Critical Paths ----------

rel_line="$(grep -n '^2\. \*\*Relationships\*\*' "$SKILL_MD" | head -1 | cut -d: -f1 || true)"
imp_line="$(grep -n '^3\. \*\*Impact\*\*' "$SKILL_MD" | head -1 | cut -d: -f1 || true)"
crit_line="$(grep -n '^4\. \*\*Critical Paths\*\*' "$SKILL_MD" | head -1 | cut -d: -f1 || true)"
risk_line="$(grep -n '^5\. \*\*Risks/Gaps\*\*' "$SKILL_MD" | head -1 | cut -d: -f1 || true)"

if [ -n "$rel_line" ] && [ -n "$imp_line" ] && [ -n "$crit_line" ] && [ -n "$risk_line" ] \
   && [ "$rel_line" -lt "$imp_line" ] \
   && [ "$imp_line" -lt "$crit_line" ] \
   && [ "$crit_line" -lt "$risk_line" ]; then
  echo "ok    contract lists Relationships < Impact < Critical Paths < Risks/Gaps"
  pass=$((pass + 1))
else
  echo "FAIL  contract section order broken (rel=$rel_line imp=$imp_line crit=$crit_line risk=$risk_line)" >&2
  fail=$((fail + 1))
fi

# Impact must be advertised as optional.
present_re "Impact is optional" '3\. \*\*Impact\*\*.*optional'

# --- Structural impact vocabulary --------------------------------------

present "Impact mentions imports"      "**imports**"
present "Impact mentions calls"        "**calls**"
present "Impact mentions containment"  "**containment**"
present "Impact mentions type-use"     "**type-use**"
present "Impact mentions docs links"   "**docs links**"
present "Impact mentions graph neighbors/paths" "**graph neighbors/paths**"

# --- Verification against the current worktree -------------------------

present_re "Impact requires worktree verification" "verified against the current worktree"

# --- Interpret graph evidence, no raw dumps ----------------------------

present_re "Impact requires interpretation over raw graph output" "Interpret graph or recall evidence into project terms"
present_re "Impact forbids raw nodes/edges/paths/recall dump" "do \*\*not\*\* paste raw nodes, edges, paths, recall output"

# --- Read-only, no ingest / reindex / graph writes ---------------------

present_re "Impact is read-only" "This section is \*\*read-only\*\*"
present_re "Impact forbids ingest/reindex/graph writes" "must not run .*memory:ingest.*reindex.*graph-write"
present_re "answer-wide read-only restatement" "The entire .zoom-out. answer is read-only"

# --- No new /impact skill or memory_impact primitive -------------------

present_re "contract forbids new /impact skill"        "must not (create or reference|introduce).*/impact"
present_re "contract forbids memory_impact primitive"  "memory_impact"

# A memory_impact mention is only allowed in the *forbidding* clauses.
# Make sure it never shows up as a callable primitive invocation.
if grep -Eq '^[[:space:]]*memory_impact\b|`memory_impact `|\$\(memory_impact' "$SKILL_MD"; then
  echo "FAIL  memory_impact appears as an invocation, not just a prohibition" >&2
  fail=$((fail + 1))
else
  echo "ok    memory_impact is not invoked anywhere"
  pass=$((pass + 1))
fi

# Same guard for a "/impact" skill invocation (allowed only in prohibitions).
if grep -Eq '(invoke|run|call|use) /impact\b' "$SKILL_MD"; then
  echo "FAIL  /impact appears as an invocation, not just a prohibition" >&2
  fail=$((fail + 1))
else
  echo "ok    /impact skill is not invoked anywhere"
  pass=$((pass + 1))
fi

# --- Summary -----------------------------------------------------------

echo
echo "passed: $pass"
echo "failed: $fail"
[ "$fail" -eq 0 ]
