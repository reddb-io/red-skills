#!/usr/bin/env bash
# Unit tests for pre_merge / post_merge lifecycle hooks and the validation
# built-in post_merge default (issue #213, PRD #207).
#
# Verifies:
#   1. afk.sh wires hook_dispatch pre_merge before the `git merge --no-ff`
#      mechanism site, with the diff and merge_base in env/ctx, abort policy
#      on non-zero (routes through the existing merge-conflict envelope path).
#   2. afk.sh wires hook_dispatch post_merge after the push, with
#      RED_AFK_MERGE_COMMIT (full sha) exported, continue policy on non-zero.
#   3. Dispatcher policies: pre_merge=abort, post_merge=continue; both are
#      members of the canonical lifecycle name set.
#   4. defaults/validation-post-merge.sh exists and is executable.
#   5. The validation default is registered at post_merge before any user
#      post_merge command, in deterministic order, and the disable toggle
#      drops it without disturbing user hooks.
#   6. validation default end-to-end: writes result.validation_status into
#      ctx for a workspace with a package.json + a passing script, marks
#      `skipped` when no package.json exists, marks `failed` when a declared
#      script exits non-zero.
#   7. Non-zero exit from a user post_merge hook is logged and the chain
#      continues.
#   8. SKILL.md documents both hooks, the validation default, the
#      RED_AFK_MERGE_COMMIT / RED_AFK_MERGE_BASE env contracts, and the
#      pre/mechanism/post ordering rule (mechanism never dispatched as hook).

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
AFK_SH="$HERE/../afk.sh"
DISP_SH="$HERE/../lib/hook-dispatcher.sh"
CONF_SH="$HERE/../lib/hook-config.sh"
SKILL_MD="$HERE/../../SKILL.md"
DEFAULTS_DIR="$(cd "$HERE/../../defaults" && pwd)"
VAL_DEF="$DEFAULTS_DIR/validation-post-merge.sh"

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

# ---------- 1+2. afk.sh wires pre_merge and post_merge ----------
expect_eq "exactly one pre_merge dispatch site" \
  "$(grep -c 'hook_dispatch pre_merge' "$AFK_SH")" "1"
expect_eq "exactly one post_merge dispatch site" \
  "$(grep -c 'hook_dispatch post_merge' "$AFK_SH")" "1"

merge_line="$(grep -n 'git -C "\$PROJECT_ROOT" merge --no-ff' "$AFK_SH" | head -1 | cut -d: -f1)"
push_line="$(grep -n 'git -C "\$PROJECT_ROOT" push origin' "$AFK_SH" | head -1 | cut -d: -f1)"
pm_line="$(grep -n 'hook_dispatch pre_merge'  "$AFK_SH" | head -1 | cut -d: -f1)"
pom_line="$(grep -n 'hook_dispatch post_merge' "$AFK_SH" | head -1 | cut -d: -f1)"

if [[ -n "$pm_line" && -n "$merge_line" && "$pm_line" -lt "$merge_line" ]]; then r=1; else r=0; fi
expect_true "pre_merge fires BEFORE the merge mechanism" "$r"
if [[ -n "$pom_line" && -n "$push_line" && "$pom_line" -gt "$push_line" ]]; then r=1; else r=0; fi
expect_true "post_merge fires AFTER the push" "$r"

# pre_merge block must build a diff and export RED_AFK_MERGE_BASE. Capture
# both the dispatch site and the abort-handling lines that follow it (the
# `if (( _afk_pm_rc != 0 ))` branch must short-circuit do_merge with rc=1
# so the merge-conflict envelope path in process_issue takes over).
pm_block="$(awk '
  /pre_merge lifecycle hook/{flag=1}
  flag {print}
  flag && /_afk_pm_rc != 0/{after=1}
  after && /^[[:space:]]*fi[[:space:]]*$/{print; exit}
' "$AFK_SH")"
expect_contains "pre_merge computes git diff against merge_base" "$pm_block" "git -C \"\$PROJECT_ROOT\" diff"
expect_contains "pre_merge exports RED_AFK_MERGE_BASE" "$pm_block" "RED_AFK_MERGE_BASE"
expect_contains "pre_merge exports RED_AFK_WORKSPACE" "$pm_block" "RED_AFK_WORKSPACE"
expect_contains "pre_merge ctx carries the diff" "$pm_block" "\$diff"

# pre_merge abort must short-circuit do_merge with rc=1 (routes through the
# merge-conflict envelope path in process_issue).
expect_contains "pre_merge abort returns 1 from do_merge" "$pm_block" "return 1"

# post_merge block must populate RED_AFK_MERGE_COMMIT (full sha) and emit a
# {merge_commit:{sha,short}} mutable slice.
pom_block="$(awk '/post_merge lifecycle hook/{flag=1} flag && /hook_dispatch post_merge/{print; exit} flag{print}' "$AFK_SH")"
expect_contains "post_merge exports RED_AFK_MERGE_COMMIT" "$pom_block" "RED_AFK_MERGE_COMMIT"
expect_contains "post_merge exports RED_AFK_MERGE_SHA"    "$pom_block" "RED_AFK_MERGE_SHA"
expect_contains "post_merge ctx carries merge_commit"     "$pom_block" "merge_commit"

# ---------- 3. dispatcher policies and canonical-name membership ----------
# shellcheck disable=SC1091
source "$DISP_SH"
expect_eq "pre_merge policy = abort"     "${HOOK_EXIT_POLICY[pre_merge]:-}"     "abort"
expect_eq "post_merge policy = continue" "${HOOK_EXIT_POLICY[post_merge]:-}"    "continue"
names="$(hook_canonical_names | sort | tr '\n' ',')"
expect_contains "canonical names include pre_merge"  ",$names" ",pre_merge,"
expect_contains "canonical names include post_merge" ",$names" ",post_merge,"

# ---------- 4. defaults file exists and is executable ----------
if [[ -f "$VAL_DEF" ]]; then r=1; else r=0; fi
expect_true "defaults/validation-post-merge.sh exists" "$r"
if [[ -x "$VAL_DEF" ]]; then r=1; else r=0; fi
expect_true "defaults/validation-post-merge.sh executable" "$r"

# ---------- 5. validation registers first at post_merge, then user hooks ----------
# shellcheck disable=SC1091
source "$CONF_SH"

mktmp_yaml() {
  local content="$1"
  local f
  f="$(mktemp -t afk-pm.XXXXXX)"
  printf '%s' "$content" > "$f"
  printf '%s' "$f"
}

f="$(mktmp_yaml 'afk:
  hooks:
    post_merge:
      - "echo user-one"
      - "echo user-two"
')"
HOOK_LISTS=()
HOOK_DEFAULTS_DISABLED=()
hook_config_load "$f"
mapfile -t pm_cmds <<< "${HOOK_LISTS[post_merge]:-}"
expect_eq "post_merge defaults+user count = 3" "${#pm_cmds[@]}" "3"
expect_eq "default 1 = validation"             "${pm_cmds[0]}" "$VAL_DEF"
expect_eq "user 1 declaration order"           "${pm_cmds[1]}" "echo user-one"
expect_eq "user 2 declaration order"           "${pm_cmds[2]}" "echo user-two"
rm -f "$f"

f="$(mktmp_yaml 'afk:
  hooks:
    post_merge:
      - "echo only-user"
    defaults:
      validation: false
')"
HOOK_LISTS=()
HOOK_DEFAULTS_DISABLED=()
hook_config_load "$f"
mapfile -t pm_cmds <<< "${HOOK_LISTS[post_merge]:-}"
expect_eq "validation disabled: count = 1 (only user)" "${#pm_cmds[@]}" "1"
expect_eq "validation disabled: user hook present"     "${pm_cmds[0]}" "echo only-user"
rm -f "$f"

# Empty config → validation still registered.
HOOK_LISTS=()
HOOK_DEFAULTS_DISABLED=()
hook_config_load "/nonexistent/path.yaml"
mapfile -t pm_cmds <<< "${HOOK_LISTS[post_merge]:-}"
expect_eq "missing config: validation still registered"  "${pm_cmds[0]:-}" "$VAL_DEF"

# ---------- 6. validation default end-to-end ----------
ws="$(mktemp -d -t afk-ws.XXXXXX)"

# (a) no package.json → skipped, ctx mutated with status=skipped
ctx_in='{"issue":{"number":7},"workspace":"'"$ws"'","merge_commit":{"sha":"abc"}}'
out="$(printf '%s' "$ctx_in" | RED_AFK_WORKSPACE="$ws" "$VAL_DEF")"
rc=$?
expect_eq "validation (no pkg): rc=0" "$rc" "0"
expect_eq "validation (no pkg): status=skipped" \
  "$(printf '%s' "$out" | jq -r '.result.validation_status // ""')" "skipped"
expect_eq "validation (no pkg): merge_commit preserved" \
  "$(printf '%s' "$out" | jq -r '.merge_commit.sha // ""')" "abc"

# (b) package.json with a passing test script → status=passed
cat > "$ws/package.json" <<'JSON'
{
  "name": "fake",
  "scripts": { "test": "true" }
}
JSON
out="$(printf '%s' "$ctx_in" | RED_AFK_WORKSPACE="$ws" "$VAL_DEF")"
rc=$?
expect_eq "validation (passing test): rc=0" "$rc" "0"
expect_eq "validation (passing test): status=passed" \
  "$(printf '%s' "$out" | jq -r '.result.validation_status // ""')" "passed"
expect_contains "validation (passing test): summary mentions test:✓" \
  "$(printf '%s' "$out" | jq -r '.result.validation_summary // ""')" "test:✓"
expect_contains "validation (passing test): summary marks lint:skip" \
  "$(printf '%s' "$out" | jq -r '.result.validation_summary // ""')" "lint:skip"

# (c) package.json with a failing script → status=failed (but rc still 0)
cat > "$ws/package.json" <<'JSON'
{
  "name": "fake",
  "scripts": { "test": "false" }
}
JSON
out="$(printf '%s' "$ctx_in" | RED_AFK_WORKSPACE="$ws" "$VAL_DEF")"
rc=$?
expect_eq "validation (failing test): rc=0 (continue policy)" "$rc" "0"
expect_eq "validation (failing test): status=failed" \
  "$(printf '%s' "$out" | jq -r '.result.validation_status // ""')" "failed"
expect_contains "validation (failing test): summary marks test:✗" \
  "$(printf '%s' "$out" | jq -r '.result.validation_summary // ""')" "test:✗"

# (d) no workspace → skipped, rc=0
out="$(printf '%s' "$ctx_in" | RED_AFK_WORKSPACE="" "$VAL_DEF")"
rc=$?
expect_eq "validation (no workspace): rc=0" "$rc" "0"
expect_eq "validation (no workspace): status=skipped" \
  "$(printf '%s' "$out" | jq -r '.result.validation_status // ""')" "skipped"

rm -rf "$ws"

# ---------- 7. user post_merge hook failure does not abort the chain ----------
HOOK_LISTS=()
hook_register post_merge 'true'
hook_register post_merge 'echo nope >&2; exit 23'
hook_register post_merge 'true'
errlog="$(mktemp)"
hook_dispatch post_merge '{"workspace":"/tmp/ws"}' >/dev/null 2>"$errlog"
rc=$?
expect_eq "post_merge continue: rc=0 despite failing user hook" "$rc" "0"
expect_contains "post_merge continue: failure logged" "$(cat "$errlog")" "rc=23"
rm -f "$errlog"

# pre_merge abort policy: first non-zero short-circuits with the script's rc.
# (Commands emit empty stdout — non-JSON stdout would trip the dispatcher's
# parse-failure branch first, which is its own abort path tested in
# hook-dispatcher.test.sh.)
HOOK_LISTS=()
hook_register pre_merge 'true'
hook_register pre_merge 'echo nope >&2; exit 31'
hook_register pre_merge 'true'
errlog="$(mktemp)"
hook_dispatch pre_merge '{"workspace":"/tmp/ws","diff":""}' >/dev/null 2>"$errlog"
rc=$?
expect_eq "pre_merge abort: rc=31 propagated" "$rc" "31"
expect_contains "pre_merge abort: failure logged" "$(cat "$errlog")" "rc=31"
rm -f "$errlog"

# ---------- 8. SKILL.md documents both hooks + the new default ----------
if grep -q '`pre_merge`'  "$SKILL_MD"; then r=1; else r=0; fi
expect_true "SKILL.md mentions pre_merge"  "$r"
if grep -q '`post_merge`' "$SKILL_MD"; then r=1; else r=0; fi
expect_true "SKILL.md mentions post_merge" "$r"
if grep -q 'RED_AFK_MERGE_COMMIT' "$SKILL_MD"; then r=1; else r=0; fi
expect_true "SKILL.md documents RED_AFK_MERGE_COMMIT env" "$r"
if grep -q 'RED_AFK_MERGE_BASE'   "$SKILL_MD"; then r=1; else r=0; fi
expect_true "SKILL.md documents RED_AFK_MERGE_BASE env"   "$r"
if grep -q 'afk.hooks.defaults.validation' "$SKILL_MD"; then r=1; else r=0; fi
expect_true "SKILL.md documents validation default disable toggle" "$r"
# The "mechanism between pre/post, never dispatched as a hook" rule must be visible.
if grep -qi 'never dispatched as a hook\|mechanism.*ADR 0008' "$SKILL_MD"; then r=1; else r=0; fi
expect_true "SKILL.md explains mechanism-between-hooks invariant" "$r"

echo
echo "summary: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
