#!/usr/bin/env bash
# Unit tests for pre_worktree / pre_attempt lifecycle hooks and the built-in
# default registration mechanism (issue #211, PRD #207; pre_worker renamed to
# pre_attempt in #226).
#
# Verifies:
#   1. afk.sh wires pre_worktree before `git worktree add` and fires
#      pre_attempt (via the _afk_fire_pre_attempt helper) before each
#      run_inner. pre_attempt is per runner invocation (#226), so there are
#      two call sites — the first runner and the --fallback-runner swap —
#      but exactly one `hook_dispatch pre_attempt` literal (in the helper).
#   2. dispatcher policies: pre_worktree=abort, pre_attempt=abort, and both
#      are members of the canonical lifecycle name set.
#   3. built-in defaults: `cargo` and `gradle` register at pre_worktree
#      ahead of any user-declared command, in deterministic order, and the
#      defaults files exist + are executable.
#   4. `defaults.cargo: false` drops only the cargo built-in from the
#      pre_worktree list; gradle and user hooks remain unaffected.
#   5. cargo built-in pass-through when no Cargo.toml; mutation when one
#      is present (emits .env.CARGO_TARGET_DIR).
#   6. gradle built-in pass-through when build.gradle* missing OR
#      RED_AFK_GRADLE_USER_HOME_BASE unset; mutation when both present.
#   7. defaults-then-user: a user pre_worktree hook sees .env populated by
#      the cargo default that ran before it.
#   8. exit-code policy: a failing user pre_worktree hook aborts and the rc
#      propagates to the caller; a failing user pre_attempt hook does the
#      same (both are abort-policy).
#   9. declaration order is preserved within multi-command user lists.
#  10. SKILL.md documents pre_worktree, pre_attempt, the cargo + gradle
#      defaults, and the disable-not-reorder rule.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
AFK_SH="$HERE/../afk.sh"
DISP_SH="$HERE/../lib/hook-dispatcher.sh"
CONF_SH="$HERE/../lib/hook-config.sh"
SKILL_MD="$HERE/../../SKILL.md"
DEFAULTS_DIR="$(cd "$HERE/../../defaults" && pwd)"
CARGO_DEF="$DEFAULTS_DIR/cargo-pre-worktree.sh"
GRADLE_DEF="$DEFAULTS_DIR/gradle-pre-worktree.sh"

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

# ---------- 1. afk.sh wires pre_worktree and pre_attempt at the right sites ----------
if grep -q 'hook_dispatch pre_worktree' "$AFK_SH"; then r=1; else r=0; fi
expect_true "afk.sh wires pre_worktree" "$r"
if grep -q '_afk_fire_pre_attempt ' "$AFK_SH"; then r=1; else r=0; fi
expect_true "afk.sh fires pre_attempt (helper invoked)" "$r"

expect_eq "exactly one pre_worktree dispatch site" \
  "$(grep -c 'hook_dispatch pre_worktree' "$AFK_SH")" "1"
# Exactly one dispatch literal — it lives in the _afk_fire_pre_attempt helper.
expect_eq "exactly one hook_dispatch pre_attempt literal" \
  "$(grep -c 'hook_dispatch pre_attempt' "$AFK_SH")" "1"
# Per-invocation cadence (#226): the helper is invoked twice — once for the
# first runner, once for the --fallback-runner swap.
expect_eq "pre_attempt fired per runner invocation (2 call sites)" \
  "$(grep -c '_afk_fire_pre_attempt "\$n"' "$AFK_SH")" "2"

pwt_line="$(grep -n 'hook_dispatch pre_worktree' "$AFK_SH" | head -1 | cut -d: -f1)"
pa_line="$(grep -n  '_afk_fire_pre_attempt "\$n"' "$AFK_SH" | head -1 | cut -d: -f1)"
worktree_add_line="$(grep -n 'worktree add "\$worktree"' "$AFK_SH" | head -1 | cut -d: -f1)"
run_inner_line="$(grep -n 'run_inner "\$worktree" "\$handoff"' "$AFK_SH" | head -1 | cut -d: -f1)"

if [[ -n "$pwt_line" && -n "$worktree_add_line" && "$pwt_line" -lt "$worktree_add_line" ]]; then r=1; else r=0; fi
expect_true "pre_worktree fires BEFORE git worktree add" "$r"

if [[ -n "$pa_line" && -n "$worktree_add_line" && -n "$run_inner_line" \
      && "$pa_line" -gt "$worktree_add_line" && "$pa_line" -lt "$run_inner_line" ]]; then r=1; else r=0; fi
expect_true "pre_attempt fires AFTER worktree add, BEFORE run_inner" "$r"

# ---------- 2. dispatcher policies and canonical-name membership ----------
# shellcheck disable=SC1091
source "$DISP_SH"
expect_eq "pre_worktree policy = abort" "${HOOK_EXIT_POLICY[pre_worktree]:-}" "abort"
expect_eq "pre_attempt policy   = abort" "${HOOK_EXIT_POLICY[pre_attempt]:-}"   "abort"
names="$(hook_canonical_names | sort | tr '\n' ',')"
expect_contains "canonical names include pre_worktree" ",$names" ",pre_worktree,"
expect_contains "canonical names include pre_attempt"   ",$names" ",pre_attempt,"

# ---------- 3. defaults files exist and are executable ----------
if [[ -f "$CARGO_DEF" ]]; then r=1; else r=0; fi
expect_true "defaults/cargo-pre-worktree.sh exists" "$r"
if [[ -x "$CARGO_DEF" ]]; then r=1; else r=0; fi
expect_true "defaults/cargo-pre-worktree.sh executable" "$r"
if [[ -f "$GRADLE_DEF" ]]; then r=1; else r=0; fi
expect_true "defaults/gradle-pre-worktree.sh exists" "$r"
if [[ -x "$GRADLE_DEF" ]]; then r=1; else r=0; fi
expect_true "defaults/gradle-pre-worktree.sh executable" "$r"

# ---------- 4. defaults register first, then user hooks (config loader) ----------
# shellcheck disable=SC1091
source "$CONF_SH"

mktmp_yaml() {
  local content="$1"
  local f
  f="$(mktemp -t afk-pwt.XXXXXX)"
  printf '%s' "$content" > "$f"
  printf '%s' "$f"
}

f="$(mktmp_yaml 'afk:
  hooks:
    pre_worktree:
      - "echo user-one"
      - "echo user-two"
')"
HOOK_LISTS=()
HOOK_DEFAULTS_DISABLED=()
hook_config_load "$f"
expect_eq "load rc=0" "$?" "0"

# Expect: cargo default, gradle default, then user-one, user-two — in that order.
mapfile -t pwt_cmds <<< "${HOOK_LISTS[pre_worktree]:-}"
expect_eq "defaults+user count = 4" "${#pwt_cmds[@]}" "4"
expect_eq "default 1 = cargo"  "${pwt_cmds[0]}" "$CARGO_DEF"
expect_eq "default 2 = gradle" "${pwt_cmds[1]}" "$GRADLE_DEF"
expect_eq "user 1 declaration order" "${pwt_cmds[2]}" "echo user-one"
expect_eq "user 2 declaration order" "${pwt_cmds[3]}" "echo user-two"
rm -f "$f"

# ---------- 5. defaults.cargo: false skips only cargo ----------
f="$(mktmp_yaml 'afk:
  hooks:
    pre_worktree:
      - "echo user-one"
    defaults:
      cargo: false
')"
HOOK_LISTS=()
HOOK_DEFAULTS_DISABLED=()
hook_config_load "$f"
mapfile -t pwt_cmds <<< "${HOOK_LISTS[pre_worktree]:-}"
expect_eq "cargo disabled: count = 2 (gradle + user)" "${#pwt_cmds[@]}" "2"
expect_eq "cargo disabled: first is gradle" "${pwt_cmds[0]}" "$GRADLE_DEF"
expect_eq "cargo disabled: user hook still present" "${pwt_cmds[1]}" "echo user-one"
rm -f "$f"

# ---------- 6. defaults.gradle: false skips only gradle ----------
f="$(mktmp_yaml 'afk:
  hooks:
    pre_worktree:
      - "echo user-one"
    defaults:
      gradle: false
')"
HOOK_LISTS=()
HOOK_DEFAULTS_DISABLED=()
hook_config_load "$f"
mapfile -t pwt_cmds <<< "${HOOK_LISTS[pre_worktree]:-}"
expect_eq "gradle disabled: count = 2 (cargo + user)" "${#pwt_cmds[@]}" "2"
expect_eq "gradle disabled: first is cargo" "${pwt_cmds[0]}" "$CARGO_DEF"
expect_eq "gradle disabled: user hook still present" "${pwt_cmds[1]}" "echo user-one"
rm -f "$f"

# Both disabled.
f="$(mktmp_yaml 'afk:
  hooks:
    pre_worktree:
      - "echo only-user"
    defaults:
      cargo: false
      gradle: false
')"
HOOK_LISTS=()
HOOK_DEFAULTS_DISABLED=()
hook_config_load "$f"
mapfile -t pwt_cmds <<< "${HOOK_LISTS[pre_worktree]:-}"
expect_eq "both disabled: only user remains" "${#pwt_cmds[@]}" "1"
expect_eq "both disabled: user content"       "${pwt_cmds[0]}" "echo only-user"
rm -f "$f"

# ---------- 7. cargo built-in: pass-through when no Cargo.toml ----------
tmpdir="$(mktemp -d -t afk-cargo-no.XXXXXX)"
in='{"issue":{"number":1},"target":"/tmp/wt","branch":"x","env":{}}'
out="$(PROJECT_ROOT="$tmpdir" printf '%s' "$in" | PROJECT_ROOT="$tmpdir" "$CARGO_DEF")"
rc=$?
expect_eq "cargo: no Cargo.toml → rc=0" "$rc" "0"
expect_eq "cargo: no Cargo.toml → empty stdout (pass-through)" "$out" ""
rm -rf "$tmpdir"

# ---------- 8. cargo built-in: mutation when Cargo.toml present ----------
tmpdir="$(mktemp -d -t afk-cargo-yes.XXXXXX)"
echo '[package]' > "$tmpdir/Cargo.toml"
cargo_base="$(mktemp -d -t afk-cargo-base.XXXXXX)"
in='{"issue":{"number":1},"target":"/tmp/wt","branch":"x","env":{}}'
out="$(PROJECT_ROOT="$tmpdir" RED_AFK_SLOT=3 RED_AFK_CARGO_TARGET_BASE="$cargo_base" \
  printf '%s' "$in" | PROJECT_ROOT="$tmpdir" RED_AFK_SLOT=3 \
  RED_AFK_CARGO_TARGET_BASE="$cargo_base" "$CARGO_DEF")"
expect_eq "cargo: applied → CARGO_TARGET_DIR set" \
  "$(printf '%s' "$out" | jq -r '.env.CARGO_TARGET_DIR')" \
  "${cargo_base}/slot-3"
expect_eq "cargo: applied → existing ctx preserved (target)" \
  "$(printf '%s' "$out" | jq -r '.target')" "/tmp/wt"
expect_true "cargo: slot dir created on disk" \
  "$([[ -d "${cargo_base}/slot-3" ]] && echo 1 || echo 0)"
rm -rf "$tmpdir" "$cargo_base"

# ---------- 9. gradle built-in: pass-through when build.gradle* missing ----------
tmpdir="$(mktemp -d -t afk-gradle-no.XXXXXX)"
in='{"issue":{"number":1},"target":"/tmp/wt","branch":"x","env":{}}'
out="$(PROJECT_ROOT="$tmpdir" RED_AFK_GRADLE_USER_HOME_BASE=/tmp/g \
  printf '%s' "$in" | PROJECT_ROOT="$tmpdir" RED_AFK_GRADLE_USER_HOME_BASE=/tmp/g \
  "$GRADLE_DEF")"
expect_eq "gradle: no build.gradle* → empty stdout" "$out" ""
rm -rf "$tmpdir"

# ---------- 10. gradle built-in: pass-through when RED_AFK_GRADLE_USER_HOME_BASE unset ----------
tmpdir="$(mktemp -d -t afk-gradle-noenv.XXXXXX)"
echo 'plugins {}' > "$tmpdir/build.gradle.kts"
in='{"issue":{"number":1},"target":"/tmp/wt","branch":"x","env":{}}'
unset RED_AFK_GRADLE_USER_HOME_BASE
out="$(PROJECT_ROOT="$tmpdir" printf '%s' "$in" | PROJECT_ROOT="$tmpdir" "$GRADLE_DEF")"
expect_eq "gradle: no opt-in env → empty stdout (no path-claim)" "$out" ""
rm -rf "$tmpdir"

# ---------- 11. gradle built-in: mutation when both conditions met ----------
tmpdir="$(mktemp -d -t afk-gradle-yes.XXXXXX)"
echo 'plugins {}' > "$tmpdir/build.gradle"
gradle_base="$(mktemp -d -t afk-gradle-base.XXXXXX)"
in='{"issue":{"number":1},"target":"/tmp/wt","branch":"x","env":{}}'
out="$(PROJECT_ROOT="$tmpdir" RED_AFK_SLOT=2 RED_AFK_GRADLE_USER_HOME_BASE="$gradle_base" \
  printf '%s' "$in" | PROJECT_ROOT="$tmpdir" RED_AFK_SLOT=2 \
  RED_AFK_GRADLE_USER_HOME_BASE="$gradle_base" "$GRADLE_DEF")"
expect_eq "gradle: applied → GRADLE_USER_HOME set" \
  "$(printf '%s' "$out" | jq -r '.env.GRADLE_USER_HOME')" \
  "${gradle_base}/slot-2"
expect_true "gradle: slot dir created on disk" \
  "$([[ -d "${gradle_base}/slot-2" ]] && echo 1 || echo 0)"
rm -rf "$tmpdir" "$gradle_base"

# ---------- 12. defaults-then-user: user hook sees defaults' .env ----------
# Wire the cargo default through the dispatcher, then a user hook that
# returns ctx.env unchanged — the dispatcher passes the mutated ctx to
# the user hook on stdin, so the user hook *reads* the env added by the
# default. Verifies the "defaults run first" contract end-to-end.
tmpdir="$(mktemp -d -t afk-chain.XXXXXX)"
echo '[package]' > "$tmpdir/Cargo.toml"
cargo_base="$(mktemp -d -t afk-chain-base.XXXXXX)"
HOOK_LISTS=()
hook_register pre_worktree "PROJECT_ROOT='$tmpdir' RED_AFK_SLOT=7 RED_AFK_CARGO_TARGET_BASE='$cargo_base' '$CARGO_DEF'"
# User hook reads ctx.env.CARGO_TARGET_DIR and tags the issue title with it.
hook_register pre_worktree 'jq ".issue.title = (.env.CARGO_TARGET_DIR // \"missing\")"'
in='{"issue":{"number":1,"title":"orig"},"target":"/tmp/wt","branch":"x","env":{}}'
out="$(hook_dispatch pre_worktree "$in")"
expect_eq "chain: user hook sees cargo default's CARGO_TARGET_DIR" \
  "$(printf '%s' "$out" | jq -r '.issue.title')" \
  "${cargo_base}/slot-7"
rm -rf "$tmpdir" "$cargo_base"

# ---------- 13. exit-code policy: pre_worktree abort propagates ----------
HOOK_LISTS=()
hook_register pre_worktree 'echo boom >&2; exit 23'
errlog="$(mktemp)"
hook_dispatch pre_worktree '{"target":"/tmp/wt"}' >/dev/null 2>"$errlog"
rc=$?
expect_eq "pre_worktree abort: rc propagated" "$rc" "23"
expect_contains "pre_worktree abort: failure logged" "$(cat "$errlog")" "rc=23"
rm -f "$errlog"

# ---------- 14. exit-code policy: pre_attempt abort propagates ----------
HOOK_LISTS=()
hook_register pre_attempt 'echo nope >&2; exit 31'
errlog="$(mktemp)"
hook_dispatch pre_attempt '{"workspace":"/tmp/ws"}' >/dev/null 2>"$errlog"
rc=$?
expect_eq "pre_attempt abort: rc propagated" "$rc" "31"
expect_contains "pre_attempt abort: failure logged" "$(cat "$errlog")" "rc=31"
rm -f "$errlog"

# ---------- 15. declaration order preserved within user list ----------
f="$(mktmp_yaml 'afk:
  hooks:
    pre_attempt:
      - "first"
      - "second"
      - "third"
')"
HOOK_LISTS=()
HOOK_DEFAULTS_DISABLED=()
hook_config_load "$f"
expect_eq "user list order preserved" \
  "$(printf '%s' "${HOOK_LISTS[pre_attempt]}" | tr '\n' ',')" \
  "first,second,third"
rm -f "$f"

# ---------- 16. SKILL.md documents both hooks + defaults + disable-not-reorder ----------
if grep -q 'pre_worktree' "$SKILL_MD"; then r=1; else r=0; fi
expect_true "SKILL.md mentions pre_worktree" "$r"
if grep -q 'pre_attempt'   "$SKILL_MD"; then r=1; else r=0; fi
expect_true "SKILL.md mentions pre_attempt"   "$r"
if grep -A1 '`pre_worktree`' "$SKILL_MD" | grep -qi 'worktree\|claim\|target'; then r=1; else r=0; fi
expect_true "SKILL.md explains when pre_worktree fires" "$r"
if grep -A1 '`pre_attempt`'   "$SKILL_MD" | grep -qi 'runner\|workspace\|invocation'; then r=1; else r=0; fi
expect_true "SKILL.md explains when pre_attempt fires" "$r"
if grep -q 'afk.hooks.defaults.cargo'  "$SKILL_MD"; then r=1; else r=0; fi
expect_true "SKILL.md documents cargo default disable" "$r"
if grep -q 'afk.hooks.defaults.gradle' "$SKILL_MD"; then r=1; else r=0; fi
expect_true "SKILL.md documents gradle default disable" "$r"
if grep -qi 'disable.*not.*reorder\|cannot.*reorder\|reorder.*not\|only.*disable' "$SKILL_MD"; then r=1; else r=0; fi
expect_true "SKILL.md documents disable-not-reorder rule" "$r"

echo
echo "summary: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
