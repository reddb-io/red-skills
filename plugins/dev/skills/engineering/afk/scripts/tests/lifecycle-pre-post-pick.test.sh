#!/usr/bin/env bash
# Unit tests for pre_pick / post_pick lifecycle hooks (issue #210, PRD #207).
#
# Verifies:
#   1. afk.sh wires pre_pick and post_pick at the right places.
#   2. dispatcher policies: pre_pick=abort, post_pick=continue.
#   3. mutation happy path for both hooks (pre_pick → query params,
#      post_pick → issues[]).
#   4. empty-stdout pass-through leaves context unchanged.
#   5. extra keys outside the documented mutable slice are silently ignored.
#   6. exit-code policy: pre_pick non-zero propagates to caller; post_pick
#      non-zero is logged and the dispatcher returns rc=0 with un-mutated ctx.
#   7. declaration-order preservation in multi-command lists.
#   8. chained mutation — a second hook sees the first hook's output.
#   9. SKILL.md documents pre_pick and post_pick.
#  10. examples/only-mine.sh exists, is executable, and filters by author.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
AFK_SH="$HERE/../afk.sh"
DISP_SH="$HERE/../lib/hook-dispatcher.sh"
SKILL_MD="$HERE/../../SKILL.md"
EXAMPLE_SH="$HERE/../../examples/only-mine.sh"

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

expect_true() {
  local label="$1" cond="$2"
  if [[ "$cond" == "1" ]]; then
    echo "PASS  $label"; pass=$((pass + 1))
  else
    echo "FAIL  $label"; fail=$((fail + 1))
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

# ---------- 1. afk.sh wires pre_pick and post_pick ----------
if grep -q 'hook_dispatch pre_pick'  "$AFK_SH"; then r=1; else r=0; fi
expect_true "afk.sh wires pre_pick"  "$r"
if grep -q 'hook_dispatch post_pick' "$AFK_SH"; then r=1; else r=0; fi
expect_true "afk.sh wires post_pick" "$r"

# Both must sit before the per-issue main loop (no re-fire per iteration).
pre_pick_line="$(grep -n 'hook_dispatch pre_pick'  "$AFK_SH" | head -1 | cut -d: -f1)"
post_pick_line="$(grep -n 'hook_dispatch post_pick' "$AFK_SH" | head -1 | cut -d: -f1)"
select_line="$(grep -n 'ISSUES_JSON="\$(select_issues)"' "$AFK_SH" | head -1 | cut -d: -f1)"
loop_line="$(grep -n 'for n in "\${NUMBERS\[@\]}"' "$AFK_SH" | head -1 | cut -d: -f1)"

if [[ -n "$pre_pick_line" && -n "$select_line" && "$pre_pick_line" -lt "$select_line" ]]; then r=1; else r=0; fi
expect_true "pre_pick fires BEFORE select_issues" "$r"

if [[ -n "$post_pick_line" && -n "$select_line" && "$post_pick_line" -gt "$select_line" \
      && -n "$loop_line" && "$post_pick_line" -lt "$loop_line" ]]; then r=1; else r=0; fi
expect_true "post_pick fires AFTER select_issues, BEFORE the main loop" "$r"

# Exactly one of each — no re-fire per iteration.
expect_eq "exactly one pre_pick dispatch site"  "$(grep -c 'hook_dispatch pre_pick'  "$AFK_SH")" "1"
expect_eq "exactly one post_pick dispatch site" "$(grep -c 'hook_dispatch post_pick' "$AFK_SH")" "1"

# ---------- 2. dispatcher policies ----------
# shellcheck disable=SC1091
source "$DISP_SH"
expect_eq "pre_pick policy = abort"     "${HOOK_EXIT_POLICY[pre_pick]:-}"  "abort"
expect_eq "post_pick policy = continue" "${HOOK_EXIT_POLICY[post_pick]:-}" "continue"
names="$(hook_canonical_names | sort | tr '\n' ',')"
expect_contains "canonical names include pre_pick"  ",$names" ",pre_pick,"
expect_contains "canonical names include post_pick" ",$names" ",post_pick,"

# ---------- 3. mutation happy path ----------
# pre_pick: replace label.
HOOK_LISTS=()
hook_register pre_pick 'jq ".label = \"my-label\""'
out="$(hook_dispatch pre_pick '{"label":"ready-for-agent","state":"open","limit":100}')"
expect_eq "pre_pick mutation: label replaced" "$(printf '%s' "$out" | jq -r '.label')" "my-label"

# post_pick: filter issues[].
HOOK_LISTS=()
hook_register post_pick 'jq "{issues: (.issues | map(select(.number >= 200)))}"'
in='{"issues":[{"number":100,"title":"a"},{"number":200,"title":"b"},{"number":300,"title":"c"}]}'
out="$(hook_dispatch post_pick "$in")"
expect_eq "post_pick mutation: issues filtered count" "$(printf '%s' "$out" | jq '.issues | length')" "2"
expect_eq "post_pick mutation: first filtered number"  "$(printf '%s' "$out" | jq '.issues[0].number')" "200"

# ---------- 4. empty-stdout pass-through ----------
HOOK_LISTS=()
hook_register pre_pick 'true'  # rc=0, empty stdout
out="$(hook_dispatch pre_pick '{"label":"ready-for-agent","limit":100}')"
expect_eq "pre_pick empty-stdout: ctx unchanged label" "$(printf '%s' "$out" | jq -r '.label')" "ready-for-agent"
expect_eq "pre_pick empty-stdout: ctx unchanged limit" "$(printf '%s' "$out" | jq -r '.limit')" "100"

HOOK_LISTS=()
hook_register post_pick 'true'
out="$(hook_dispatch post_pick '{"issues":[{"number":1}]}')"
expect_eq "post_pick empty-stdout: ctx unchanged" "$(printf '%s' "$out" | jq '.issues[0].number')" "1"

# ---------- 5. extra keys outside mutable slice are ignored by the consumer ----------
# AFK consumes only documented keys (.label/.state/.limit for pre_pick, .issues
# for post_pick). The dispatcher does full ctx replacement, but downstream
# consumption is via jq path extraction — so junk keys are inert by design.
HOOK_LISTS=()
hook_register post_pick 'jq ". + {\"junk\":42,\"other\":\"ignored\"}"'
out="$(hook_dispatch post_pick '{"issues":[{"number":1}]}')"
# Original issues are preserved; junk lives in ctx but AFK never reads it.
expect_eq "extra keys: original .issues preserved" "$(printf '%s' "$out" | jq '.issues[0].number')" "1"
expect_eq "extra keys: junk key present in raw ctx (downstream ignores)" "$(printf '%s' "$out" | jq -r '.junk')" "42"

# ---------- 6. exit-code policy ----------
# pre_pick: abort → propagate rc (the abort policy returns the failing rc).
HOOK_LISTS=()
hook_register pre_pick 'echo "boom" >&2; exit 17'
errlog="$(mktemp)"
hook_dispatch pre_pick '{"label":"ready-for-agent"}' >/dev/null 2>"$errlog"
rc=$?
expect_eq "pre_pick abort: rc propagated"      "$rc" "17"
expect_contains "pre_pick abort: failure logged" "$(cat "$errlog")" "rc=17"
rm -f "$errlog"

# post_pick: continue → rc=0 even on failure, ctx is left unchanged.
HOOK_LISTS=()
hook_register post_pick 'echo "filter bug" >&2; exit 1'
errlog="$(mktemp)"
out="$(hook_dispatch post_pick '{"issues":[{"number":1},{"number":2}]}' 2>"$errlog")"
rc=$?
expect_eq "post_pick continue: rc=0"             "$rc" "0"
expect_eq "post_pick continue: ctx unchanged (count)" "$(printf '%s' "$out" | jq '.issues | length')" "2"
expect_contains "post_pick continue: failure logged" "$(cat "$errlog")" "rc=1"
rm -f "$errlog"

# ---------- 7. declaration order preserved ----------
HOOK_LISTS=()
hook_register pre_pick 'jq ".trace += [\"a\"]"'
hook_register pre_pick 'jq ".trace += [\"b\"]"'
hook_register pre_pick 'jq ".trace += [\"c\"]"'
out="$(hook_dispatch pre_pick '{"trace":[]}')"
expect_eq "declaration order: a,b,c" "$(printf '%s' "$out" | jq -c '.trace')" '["a","b","c"]'

# ---------- 8. chained mutation: second hook sees first hook's output ----------
HOOK_LISTS=()
hook_register post_pick 'jq "{issues: (.issues | map(select(.number > 1)))}"'
hook_register post_pick 'jq ".issues |= map(. + {seen_by_second: true})"'
in='{"issues":[{"number":1},{"number":2},{"number":3}]}'
out="$(hook_dispatch post_pick "$in")"
expect_eq "chained: second sees first filter (count)" \
  "$(printf '%s' "$out" | jq '.issues | length')" "2"
expect_eq "chained: second annotates all issues left by first" \
  "$(printf '%s' "$out" | jq '[.issues[].seen_by_second] | all')" "true"

# ---------- 9. SKILL.md documents both hooks ----------
if grep -q 'pre_pick'  "$SKILL_MD"; then r=1; else r=0; fi
expect_true "SKILL.md mentions pre_pick"  "$r"
if grep -q 'post_pick' "$SKILL_MD"; then r=1; else r=0; fi
expect_true "SKILL.md mentions post_pick" "$r"
if grep -A1 '`pre_pick`'  "$SKILL_MD" | grep -qi 'listing\|queue\|pick'; then r=1; else r=0; fi
expect_true "SKILL.md explains when pre_pick fires"  "$r"
if grep -A1 '`post_pick`' "$SKILL_MD" | grep -qi 'listing\|claim\|filter\|reorder\|issues'; then r=1; else r=0; fi
expect_true "SKILL.md explains when post_pick fires" "$r"
if grep -q 'only-mine\.sh' "$SKILL_MD"; then r=1; else r=0; fi
expect_true "SKILL.md links the only-mine.sh example" "$r"

# ---------- 10. examples/only-mine.sh ----------
if [[ -f "$EXAMPLE_SH" ]]; then r=1; else r=0; fi
expect_true "examples/only-mine.sh exists" "$r"
if [[ -x "$EXAMPLE_SH" ]]; then r=1; else r=0; fi
expect_true "examples/only-mine.sh is executable" "$r"

# When RED_AFK_GITHUB_LOGIN is unset, the example exits 0 with empty stdout
# (queue preserved by the dispatcher's empty-stdout pass-through).
in='{"issues":[{"number":1,"author":{"login":"alice"}},{"number":2,"author":{"login":"bob"}}]}'
unset RED_AFK_GITHUB_LOGIN
out="$(printf '%s' "$in" | "$EXAMPLE_SH"; echo "rc=$?")"
expect_contains "only-mine: no login → empty stdout, rc=0" "$out" "rc=0"
# Without a login we expect no JSON content in stdout — only the rc= trailer.
expect_eq "only-mine: no login → stdout empty" "$(printf '%s' "$in" | "$EXAMPLE_SH")" ""

# With a login set, only matching-author issues survive.
out="$(printf '%s' "$in" | RED_AFK_GITHUB_LOGIN=alice "$EXAMPLE_SH")"
expect_eq "only-mine: with login → filtered count" \
  "$(printf '%s' "$out" | jq '.issues | length')" "1"
expect_eq "only-mine: with login → kept correct issue" \
  "$(printf '%s' "$out" | jq -r '.issues[0].author.login')" "alice"

# End-to-end through the dispatcher: only-mine.sh wired as a post_pick hook.
HOOK_LISTS=()
hook_register post_pick "RED_AFK_GITHUB_LOGIN=alice '$EXAMPLE_SH'"
out="$(hook_dispatch post_pick "$in")"
expect_eq "only-mine via post_pick: 1 issue survives" \
  "$(printf '%s' "$out" | jq '.issues | length')" "1"
expect_eq "only-mine via post_pick: kept alice" \
  "$(printf '%s' "$out" | jq -r '.issues[0].author.login')" "alice"

echo
echo "summary: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
