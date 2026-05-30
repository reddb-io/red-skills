#!/usr/bin/env bash
# Unit tests for the on_session_error last-gasp lifecycle hook (issue #214,
# PRD #207).
#
# Verifies:
#   1. afk.sh wires the EXIT trap that dispatches on_session_error and
#      defines AFK_SESSION_CLEAN_EXIT + the _afk_on_session_error_handler
#      function — exactly one trap install site.
#   2. Dispatcher policy: on_session_error=continue, and the name is in
#      the canonical lifecycle name set.
#   3. The handler fires hook_dispatch on_session_error on a simulated
#      crash (non-zero exit without the clean sentinel) and populates
#      RED_AFK_ERROR_CLASS / RED_AFK_ERROR_MESSAGE for the chain.
#   4. The handler does NOT fire when AFK_SESSION_CLEAN_EXIT=1
#      (post_session reached, on_idle exit, cleanup trap, pre_session
#      abort, straggler decline).
#   5. The handler does NOT fire on rc=0 (the trap is best-effort and
#      treats a clean rc as a normal exit even if the sentinel was never
#      set — defensive against an early-boot exit before any AFK code
#      runs).
#   6. The handler does NOT fire on a per-attempt crash — per-attempt
#      crashes are caught by process_issue's on_attempt_error branch which
#      returns 0 from the function, so the outer loop is unaffected.
#   7. A failing on_session_error hook does NOT prevent the process from
#      terminating: the handler always returns 0, so the script's
#      original rc is preserved at exit.
#   8. The cleanup trap (INT/TERM), the on_idle exit, the pre_session
#      abort, the hook_config_load failure, the straggler decline, and
#      the end-of-script post_session site all set
#      AFK_SESSION_CLEAN_EXIT=1 before their explicit `exit`.
#   9. SKILL.md documents on_session_error and the distinction from
#      on_attempt_error / post_session.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
AFK_SH="$HERE/../afk.sh"
DISP_SH="$HERE/../lib/hook-dispatcher.sh"
SKILL_MD="$HERE/../../SKILL.md"

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

# ---------- 1. afk.sh wires the EXIT trap + handler ----------
expect_eq "exactly one on_session_error dispatch site" \
  "$(grep -c 'hook_dispatch on_session_error' "$AFK_SH")" "1"
expect_eq "exactly one EXIT trap install" \
  "$(grep -c '^trap _afk_on_session_error_handler EXIT' "$AFK_SH")" "1"

if grep -q '^AFK_SESSION_CLEAN_EXIT=0' "$AFK_SH"; then r=1; else r=0; fi
expect_true "afk.sh defines AFK_SESSION_CLEAN_EXIT=0 default" "$r"
if grep -q '^_afk_on_session_error_handler()' "$AFK_SH"; then r=1; else r=0; fi
expect_true "afk.sh defines _afk_on_session_error_handler" "$r"

# The handler block must export RED_AFK_ERROR_CLASS and dispatch the chain.
handler_block="$(awk '/^_afk_on_session_error_handler\(\)/{flag=1} flag{print} flag && /^}/{exit}' "$AFK_SH")"
expect_contains "handler exports RED_AFK_ERROR_CLASS" "$handler_block" "RED_AFK_ERROR_CLASS"
expect_contains "handler defaults class to session-crash" "$handler_block" "session-crash"
expect_contains "handler honours AFK_SESSION_CLEAN_EXIT sentinel" \
  "$handler_block" "AFK_SESSION_CLEAN_EXIT"
expect_contains "handler dispatches on_session_error chain" \
  "$handler_block" "hook_dispatch on_session_error"
# Handler must always return 0 — non-zero from a hook must NOT block exit.
expect_contains "handler always returns 0 (never blocks process exit)" \
  "$handler_block" "return 0"

# ---------- 2. dispatcher policy + canonical-name membership ----------
# shellcheck disable=SC1091
source "$DISP_SH"
expect_eq "on_session_error policy = continue" \
  "${HOOK_EXIT_POLICY[on_session_error]:-}" "continue"
names="$(hook_canonical_names | sort | tr '\n' ',')"
expect_contains "canonical names include on_session_error" \
  ",$names" ",on_session_error,"

# ---------- 3. handler fires on simulated crash ----------
# Source afk.sh (its main-block guard returns early when sourced) so the
# handler + sentinel are loaded in this shell.
# shellcheck disable=SC1090
source "$AFK_SH"
set +e   # afk.sh enables `set -eo pipefail`; tests need non-zero returns.

calls_file="$(mktemp -t afk-osec.XXXXXX)"
HOOK_LISTS=()
hook_register on_session_error "tee >(cat >> \"$calls_file\") >/dev/null"

# Simulate a crash: rc=42, sentinel unset.
AFK_SESSION_CLEAN_EXIT=0
RED_AFK_ERROR_CLASS=""
RED_AFK_ERROR_MESSAGE=""
( exit 42 )
_afk_on_session_error_handler
rc=$?
expect_eq "handler returns 0 on simulated crash" "$rc" "0"
captured="$(cat "$calls_file")"
expect_contains "handler dispatched chain (ctx reached the hook)" \
  "$captured" "error"
expect_contains "ctx carries error.class = session-crash" \
  "$captured" "session-crash"
expect_contains "ctx carries error.rc = 42" "$captured" "42"
expect_contains "RED_AFK_ERROR_CLASS exported for the hook" \
  "$RED_AFK_ERROR_CLASS" "session-crash"
rm -f "$calls_file"

# ---------- 4. sentinel suppresses dispatch (clean shutdown paths) ----------
calls_file="$(mktemp -t afk-osec.XXXXXX)"
HOOK_LISTS=()
hook_register on_session_error "tee >(cat >> \"$calls_file\") >/dev/null"
AFK_SESSION_CLEAN_EXIT=1
( exit 7 )                      # rc=7, but clean sentinel set
_afk_on_session_error_handler
rc=$?
expect_eq "handler returns 0 when clean sentinel set" "$rc" "0"
expect_eq "no dispatch when sentinel set (clean shutdown)" \
  "$(wc -c < "$calls_file" | tr -d ' ')" "0"
rm -f "$calls_file"

# ---------- 5. rc=0 never fires on_session_error ----------
calls_file="$(mktemp -t afk-osec.XXXXXX)"
HOOK_LISTS=()
hook_register on_session_error "tee >(cat >> \"$calls_file\") >/dev/null"
AFK_SESSION_CLEAN_EXIT=0
( exit 0 )                      # rc=0, sentinel unset
_afk_on_session_error_handler
rc=$?
expect_eq "handler returns 0 when rc=0" "$rc" "0"
expect_eq "no dispatch when rc=0 even without sentinel" \
  "$(wc -c < "$calls_file" | tr -d ' ')" "0"
rm -f "$calls_file"

# ---------- 6. per-attempt crash path does not propagate to session error ----------
# process_issue's on_attempt_error branch handles run_inner non-zero exits
# locally and returns 0 from the function — meaning the outer for-loop in
# main does NOT see a non-zero status from a per-attempt crash. We verify
# the wiring contract: the on_attempt_error block returns 0 (no `exit`)
# and the on_session_error handler is therefore never reached.
owe_block="$(awk '/on_attempt_error lifecycle hook/{flag=1} flag{print} flag && /return 0$/{exit}' "$AFK_SH")"
if echo "$owe_block" | grep -qE '^[[:space:]]*return 0$'; then r=1; else r=0; fi
expect_true "on_attempt_error branch returns 0 (does not propagate to session)" "$r"
if echo "$owe_block" | grep -qE '^[[:space:]]*exit '; then r=1; else r=0; fi
expect_eq "on_attempt_error branch does not exit (per-attempt crash stays local)" "$r" "0"

# ---------- 7. failing on_session_error hook does NOT block process exit ----------
# Even if the user hook exits 99, the handler must return 0 — the EXIT
# trap is invoked just before the shell exits, so a non-zero handler
# would (in some bash configurations) replace the original rc. Returning 0
# preserves the script's original rc at exit and the process still
# terminates.
HOOK_LISTS=()
hook_register on_session_error 'echo boom >&2; exit 99'
AFK_SESSION_CLEAN_EXIT=0
errlog="$(mktemp)"
( exit 42 )
_afk_on_session_error_handler 2>"$errlog"
rc=$?
expect_eq "failing user hook does not block exit (handler rc=0)" "$rc" "0"
rm -f "$errlog"

# ---------- 8. every known intentional exit sets the clean sentinel ----------
# cleanup trap (INT/TERM)
if grep -B1 'exit 130' "$AFK_SH" | grep -q 'AFK_SESSION_CLEAN_EXIT=1'; then r=1; else r=0; fi
expect_true "cleanup trap sets AFK_SESSION_CLEAN_EXIT=1 before exit 130" "$r"

# pre_session abort
if grep -B1 'pre_session hook aborted session' "$AFK_SH" | grep -q '✗ pre_session'; then r=1; else r=0; fi
expect_true "pre_session abort log is present (anchor)" "$r"
ps_block="$(awk '/pre_session hook aborted session/{flag=1} flag{print} flag && /exit "\$_rc"/{exit}' "$AFK_SH")"
expect_contains "pre_session abort sets AFK_SESSION_CLEAN_EXIT=1" \
  "$ps_block" "AFK_SESSION_CLEAN_EXIT=1"

# hook_config_load failure
hcf_block="$(awk '/hook config load failed/{flag=1} flag{print} flag && /exit "\$_rc"/{exit}' "$AFK_SH")"
expect_contains "hook_config_load abort sets AFK_SESSION_CLEAN_EXIT=1" \
  "$hcf_block" "AFK_SESSION_CLEAN_EXIT=1"

# straggler decline
str_block="$(awk '/aborted by user/{print}' "$AFK_SH")"
expect_contains "straggler decline sets AFK_SESSION_CLEAN_EXIT=1" \
  "$str_block" "AFK_SESSION_CLEAN_EXIT=1"

# on_idle clean exit
idle_block="$(awk '/on_idle hook reported non-zero/{flag=1} flag{print} flag && /exit 0$/{exit}' "$AFK_SH")"
expect_contains "on_idle clean exit sets AFK_SESSION_CLEAN_EXIT=1" \
  "$idle_block" "AFK_SESSION_CLEAN_EXIT=1"

# end-of-script after post_session
eos_block="$(awk '/post_session hook reported non-zero/{flag=1} flag{print}' "$AFK_SH")"
expect_contains "end-of-script sets AFK_SESSION_CLEAN_EXIT=1 after post_session" \
  "$eos_block" "AFK_SESSION_CLEAN_EXIT=1"

# ---------- 9. SKILL.md documents on_session_error ----------
if grep -q '`on_session_error`' "$SKILL_MD"; then r=1; else r=0; fi
expect_true "SKILL.md mentions on_session_error" "$r"
# Select the lifecycle *table row* (starts with `| `on_session_error``), not the
# envelope-ordering prose that also name-drops the hook in backticks.
osec_row="$(grep -F '| `on_session_error`' "$SKILL_MD" | head -1)"
expect_contains "SKILL.md on_session_error documents session-crash class" \
  "$osec_row" "session-crash"
expect_contains "SKILL.md on_session_error distinct from on_attempt_error" \
  "$osec_row" "on_attempt_error"
expect_contains "SKILL.md on_session_error distinct from post_session" \
  "$osec_row" "post_session"
expect_contains "SKILL.md on_session_error documents non-zero is logged" \
  "$osec_row" "logged"
expect_contains "SKILL.md on_session_error documents process still exits" \
  "$osec_row" "process still exits"

echo
echo "summary: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
