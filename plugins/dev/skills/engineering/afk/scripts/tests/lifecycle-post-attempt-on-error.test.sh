#!/usr/bin/env bash
# Unit tests for post_worker / on_worker_error lifecycle hooks and the
# heartbeat + envelope built-in post_worker defaults (issue #212, PRD #207).
#
# Verifies:
#   1. afk.sh wires post_worker after run_inner (success or clean fail) and
#      on_worker_error on a runner crash branch — exactly one dispatch site
#      each, and on_worker_error is gated so it does not fire on quota
#      exhaustion or on result.status=fail.
#   2. dispatcher policies: post_worker=continue, on_worker_error=continue,
#      and both are members of the canonical lifecycle name set.
#   3. heartbeat + envelope defaults files exist + are executable.
#   4. Defaults register at post_worker before any user-declared post_worker
#      command, in deterministic order, and the disable toggles drop them
#      individually without disturbing siblings or user hooks.
#   5. heartbeat default: kills RED_AFK_HEARTBEAT_PID, writes the iteration-
#      stopped boundary marker into RED_AFK_ITER_LOG, and emits empty stdout
#      (pass-through).
#   6. envelope default: writes ctx.result.status into state.current.result_status,
#      uses RED_AFK_RESULT_STATUS as fallback when ctx is empty, no-ops when
#      RED_AFK_STATE_FILE is unset.
#   7. Non-zero exit from a user post_worker / on_worker_error hook is logged
#      and the chain continues.
#   8. SKILL.md documents both hooks and the new defaults.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
AFK_SH="$HERE/../afk.sh"
DISP_SH="$HERE/../lib/hook-dispatcher.sh"
CONF_SH="$HERE/../lib/hook-config.sh"
SKILL_MD="$HERE/../../SKILL.md"
DEFAULTS_DIR="$(cd "$HERE/../../defaults" && pwd)"
HB_DEF="$DEFAULTS_DIR/heartbeat-post-worker.sh"
EV_DEF="$DEFAULTS_DIR/envelope-post-worker.sh"

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

# ---------- 1. afk.sh wires post_worker and on_worker_error ----------
expect_eq "exactly one post_worker dispatch site" \
  "$(grep -c 'hook_dispatch post_worker' "$AFK_SH")" "1"
expect_eq "exactly one on_worker_error dispatch site" \
  "$(grep -c 'hook_dispatch on_worker_error' "$AFK_SH")" "1"

run_inner_line="$(grep -n 'run_inner "\$worktree" "\$handoff" "\$RUNNER")"' "$AFK_SH" | head -1 | cut -d: -f1)"
pow_line="$(grep -n 'hook_dispatch post_worker'    "$AFK_SH" | head -1 | cut -d: -f1)"
owe_line="$(grep -n 'hook_dispatch on_worker_error' "$AFK_SH" | head -1 | cut -d: -f1)"

if [[ -n "$pow_line" && -n "$run_inner_line" && "$pow_line" -gt "$run_inner_line" ]]; then r=1; else r=0; fi
expect_true "post_worker fires AFTER run_inner" "$r"
if [[ -n "$owe_line" && -n "$run_inner_line" && "$owe_line" -gt "$run_inner_line" ]]; then r=1; else r=0; fi
expect_true "on_worker_error fires AFTER run_inner" "$r"
if [[ -n "$owe_line" && -n "$pow_line" && "$owe_line" -lt "$pow_line" ]]; then r=1; else r=0; fi
expect_true "on_worker_error dispatch precedes post_worker dispatch (crash short-circuits)" "$r"

# on_worker_error must be gated by a non-zero runner rc AND not-exhausted.
owe_block="$(awk '/on_worker_error lifecycle hook/{flag=1} flag && /hook_dispatch on_worker_error/{print; exit} flag{print}' "$AFK_SH")"
expect_contains "on_worker_error gated by runner rc != 0" "$owe_block" "_runner_rc != 0"
expect_contains "on_worker_error excludes RUNNER_EXHAUSTED" "$owe_block" "RUNNER_EXHAUSTED"

# post_worker must classify result.status from the DONE sentinel.
pow_block="$(awk '/post_worker lifecycle hook/{flag=1} flag && /hook_dispatch post_worker/{print; exit} flag{print}' "$AFK_SH")"
expect_contains "post_worker classifies success on DONE sentinel" "$pow_block" "<promise>DONE</promise>"
expect_contains "post_worker exports RED_AFK_RESULT_STATUS"        "$pow_block" "RED_AFK_RESULT_STATUS"
expect_contains "post_worker exports RED_AFK_HEARTBEAT_PID"        "$pow_block" "RED_AFK_HEARTBEAT_PID"
expect_contains "post_worker exports RED_AFK_STATE_FILE"           "$pow_block" "RED_AFK_STATE_FILE"

# The lonely inline heartbeat_stop that used to sit immediately before
# `# sentinel detection` has been migrated into the post_worker heartbeat
# default. The exhausted-runner and on_worker_error branches still own
# their own heartbeat_stop calls (those terminate before the post_worker
# dispatch happens), so we narrow this check to the 5 lines directly
# above the sentinel-detection marker.
sentinel_line="$(grep -n '^[[:space:]]*# sentinel detection$' "$AFK_SH" | head -1 | cut -d: -f1)"
if [[ -n "$sentinel_line" ]]; then
  pre_window="$(sed -n "$((sentinel_line - 5)),$((sentinel_line - 1))p" "$AFK_SH")"
  hb_count_window="$(printf '%s\n' "$pre_window" | grep -c '^[[:space:]]*heartbeat_stop$' || true)"
  expect_eq "inline heartbeat_stop migrated out of pre-sentinel block" "$hb_count_window" "0"
else
  expect_true "could locate sentinel-detection marker" "0"
fi

# ---------- 2. dispatcher policies and canonical-name membership ----------
# shellcheck disable=SC1091
source "$DISP_SH"
expect_eq "post_worker policy = continue"     "${HOOK_EXIT_POLICY[post_worker]:-}"     "continue"
expect_eq "on_worker_error policy = continue" "${HOOK_EXIT_POLICY[on_worker_error]:-}" "continue"
names="$(hook_canonical_names | sort | tr '\n' ',')"
expect_contains "canonical names include post_worker"     ",$names" ",post_worker,"
expect_contains "canonical names include on_worker_error" ",$names" ",on_worker_error,"

# ---------- 3. defaults files exist and are executable ----------
if [[ -f "$HB_DEF" ]]; then r=1; else r=0; fi
expect_true "defaults/heartbeat-post-worker.sh exists" "$r"
if [[ -x "$HB_DEF" ]]; then r=1; else r=0; fi
expect_true "defaults/heartbeat-post-worker.sh executable" "$r"
if [[ -f "$EV_DEF" ]]; then r=1; else r=0; fi
expect_true "defaults/envelope-post-worker.sh exists" "$r"
if [[ -x "$EV_DEF" ]]; then r=1; else r=0; fi
expect_true "defaults/envelope-post-worker.sh executable" "$r"

# ---------- 4. defaults register first at post_worker, then user hooks ----------
# shellcheck disable=SC1091
source "$CONF_SH"

mktmp_yaml() {
  local content="$1"
  local f
  f="$(mktemp -t afk-pow.XXXXXX)"
  printf '%s' "$content" > "$f"
  printf '%s' "$f"
}

f="$(mktmp_yaml 'afk:
  hooks:
    post_worker:
      - "echo user-one"
      - "echo user-two"
')"
HOOK_LISTS=()
HOOK_DEFAULTS_DISABLED=()
hook_config_load "$f"

mapfile -t pow_cmds <<< "${HOOK_LISTS[post_worker]:-}"
expect_eq "post_worker defaults+user count = 4" "${#pow_cmds[@]}" "4"
expect_eq "default 1 = heartbeat" "${pow_cmds[0]}" "$HB_DEF"
expect_eq "default 2 = envelope"  "${pow_cmds[1]}" "$EV_DEF"
expect_eq "user 1 declaration order" "${pow_cmds[2]}" "echo user-one"
expect_eq "user 2 declaration order" "${pow_cmds[3]}" "echo user-two"
rm -f "$f"

# disable heartbeat only
f="$(mktmp_yaml 'afk:
  hooks:
    post_worker:
      - "echo user-one"
    defaults:
      heartbeat: false
')"
HOOK_LISTS=()
HOOK_DEFAULTS_DISABLED=()
hook_config_load "$f"
mapfile -t pow_cmds <<< "${HOOK_LISTS[post_worker]:-}"
expect_eq "heartbeat disabled: count = 2 (envelope + user)" "${#pow_cmds[@]}" "2"
expect_eq "heartbeat disabled: first is envelope" "${pow_cmds[0]}" "$EV_DEF"
expect_eq "heartbeat disabled: user hook still present" "${pow_cmds[1]}" "echo user-one"
rm -f "$f"

# disable envelope only
f="$(mktmp_yaml 'afk:
  hooks:
    post_worker:
      - "echo user-one"
    defaults:
      envelope: false
')"
HOOK_LISTS=()
HOOK_DEFAULTS_DISABLED=()
hook_config_load "$f"
mapfile -t pow_cmds <<< "${HOOK_LISTS[post_worker]:-}"
expect_eq "envelope disabled: count = 2 (heartbeat + user)" "${#pow_cmds[@]}" "2"
expect_eq "envelope disabled: first is heartbeat" "${pow_cmds[0]}" "$HB_DEF"
rm -f "$f"

# both disabled
f="$(mktmp_yaml 'afk:
  hooks:
    post_worker:
      - "echo only-user"
    defaults:
      heartbeat: false
      envelope: false
')"
HOOK_LISTS=()
HOOK_DEFAULTS_DISABLED=()
hook_config_load "$f"
mapfile -t pow_cmds <<< "${HOOK_LISTS[post_worker]:-}"
expect_eq "both disabled: only user remains" "${#pow_cmds[@]}" "1"
expect_eq "both disabled: user content" "${pow_cmds[0]}" "echo only-user"
rm -f "$f"

# ---------- 5. heartbeat default: stops pid + writes boundary marker ----------
# Spawn a long-lived sleep we control, hand its pid to the heartbeat default,
# confirm it gets reaped and the boundary marker lands in the iteration log.
sleep 600 &
hb_pid=$!
disown "$hb_pid" 2>/dev/null || true
iterlog="$(mktemp -t afk-iter.XXXXXX)"
ctx_in='{"issue":{"number":1},"workspace":"/tmp/ws","result":{"status":"success"}}'
out="$(printf '%s' "$ctx_in" | RED_AFK_HEARTBEAT_PID="$hb_pid" RED_AFK_ITER_LOG="$iterlog" "$HB_DEF")"
rc=$?
expect_eq "heartbeat default: rc=0" "$rc" "0"
expect_eq "heartbeat default: pass-through (empty stdout)" "$out" ""
# Give the kernel a beat to reap the SIGTERM.
sleep 0.2
if kill -0 "$hb_pid" 2>/dev/null; then alive=1; else alive=0; fi
expect_eq "heartbeat default: sub-shell terminated" "$alive" "0"
expect_contains "heartbeat default: boundary marker written" "$(cat "$iterlog")" "iteration stopped"
kill "$hb_pid" 2>/dev/null || true
rm -f "$iterlog"

# heartbeat default with empty pid: no-op, still exits 0.
out="$(printf '%s' "$ctx_in" | RED_AFK_HEARTBEAT_PID="" RED_AFK_ITER_LOG="" "$HB_DEF")"
rc=$?
expect_eq "heartbeat default (empty env): rc=0 no-op" "$rc" "0"
expect_eq "heartbeat default (empty env): empty stdout" "$out" ""

# ---------- 6. envelope default: writes result.status to state file ----------
state="$(mktemp -t afk-state.XXXXXX)"
echo '{"version":1,"current":{"number":42,"stage":"impl"}}' > "$state"
ctx_in='{"issue":{"number":42},"workspace":"/tmp/ws","result":{"status":"success"}}'
out="$(printf '%s' "$ctx_in" | RED_AFK_STATE_FILE="$state" "$EV_DEF")"
rc=$?
expect_eq "envelope default: rc=0" "$rc" "0"
expect_eq "envelope default: pass-through (empty stdout)" "$out" ""
expect_eq "envelope default: result_status=success written to state" \
  "$(jq -r '.current.result_status // ""' "$state")" "success"
expect_eq "envelope default: preserves existing current.stage" \
  "$(jq -r '.current.stage // ""' "$state")" "impl"

# fail status
echo '{"version":1,"current":{"number":42}}' > "$state"
ctx_in='{"issue":{"number":42},"workspace":"/tmp/ws","result":{"status":"fail"}}'
printf '%s' "$ctx_in" | RED_AFK_STATE_FILE="$state" "$EV_DEF" >/dev/null
expect_eq "envelope default: result_status=fail" \
  "$(jq -r '.current.result_status // ""' "$state")" "fail"

# fallback to RED_AFK_RESULT_STATUS when ctx empty.
echo '{"version":1,"current":{"number":42}}' > "$state"
out="$(printf '' | RED_AFK_STATE_FILE="$state" RED_AFK_RESULT_STATUS="success" "$EV_DEF")"
expect_eq "envelope default: env fallback wins when ctx empty" \
  "$(jq -r '.current.result_status // ""' "$state")" "success"

# no state file: no-op, still rc=0.
out="$(printf '%s' "$ctx_in" | RED_AFK_STATE_FILE="" "$EV_DEF")"
rc=$?
expect_eq "envelope default (no state): rc=0 no-op" "$rc" "0"
expect_eq "envelope default (no state): empty stdout" "$out" ""
rm -f "$state"

# ---------- 7. user hook failure does not abort the chain (continue policy) ----------
HOOK_LISTS=()
hook_register post_worker 'echo first-ok'
hook_register post_worker 'echo nope >&2; exit 17'
hook_register post_worker 'echo last-ok'
errlog="$(mktemp)"
hook_dispatch post_worker '{"workspace":"/tmp/ws"}' >/dev/null 2>"$errlog"
rc=$?
expect_eq "post_worker continue: rc=0 despite failing user hook" "$rc" "0"
expect_contains "post_worker continue: failure logged" "$(cat "$errlog")" "rc=17"
rm -f "$errlog"

HOOK_LISTS=()
hook_register on_worker_error 'echo boom >&2; exit 19'
errlog="$(mktemp)"
hook_dispatch on_worker_error '{"workspace":"/tmp/ws"}' >/dev/null 2>"$errlog"
rc=$?
expect_eq "on_worker_error continue: rc=0 despite failing user hook" "$rc" "0"
expect_contains "on_worker_error continue: failure logged" "$(cat "$errlog")" "rc=19"
rm -f "$errlog"

# ---------- 8. SKILL.md documents both hooks + the new defaults ----------
if grep -q '`post_worker`' "$SKILL_MD"; then r=1; else r=0; fi
expect_true "SKILL.md mentions post_worker" "$r"
if grep -q '`on_worker_error`' "$SKILL_MD"; then r=1; else r=0; fi
expect_true "SKILL.md mentions on_worker_error" "$r"
if grep -q 'RED_AFK_RESULT_STATUS' "$SKILL_MD"; then r=1; else r=0; fi
expect_true "SKILL.md documents RED_AFK_RESULT_STATUS contract" "$r"
if grep -q 'RED_AFK_ERROR_CLASS' "$SKILL_MD"; then r=1; else r=0; fi
expect_true "SKILL.md documents RED_AFK_ERROR_CLASS contract" "$r"
if grep -q 'afk.hooks.defaults.heartbeat' "$SKILL_MD"; then r=1; else r=0; fi
expect_true "SKILL.md documents heartbeat default disable" "$r"
if grep -q 'afk.hooks.defaults.envelope' "$SKILL_MD"; then r=1; else r=0; fi
expect_true "SKILL.md documents envelope default disable" "$r"
# The "distinct from result.status=fail" rationale should be visible.
if grep -qi 'unhandled exception\|runner crash\|demultiplex' "$SKILL_MD"; then r=1; else r=0; fi
expect_true "SKILL.md explains the post_worker / on_worker_error distinction" "$r"

echo
echo "summary: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
