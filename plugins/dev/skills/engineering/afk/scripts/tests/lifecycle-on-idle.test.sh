#!/usr/bin/env bash
# Unit tests for the on_idle lifecycle hook (issue #209, PRD #207).
#
# Verifies:
#   1. afk.sh dispatches on_idle on the empty-queue path, before exit.
#   2. afk.sh does NOT dispatch on_idle on the post-loop session-exit path
#      (that's post_session's job).
#   3. dispatcher policy for on_idle is `continue` — non-zero exits log and
#      do not abort.
#   4. the cargo-clean example command from the PRD works end-to-end:
#      a non-zero exit from the cleanup is logged and the dispatcher
#      returns rc=0.
#   5. on_idle is in the canonical lifecycle name set with the right policy.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
AFK_SH="$HERE/../afk.sh"
DISP_SH="$HERE/../lib/hook-dispatcher.sh"

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

# ---------- 1. afk.sh wires on_idle on the empty-queue path ----------
if grep -q 'hook_dispatch on_idle' "$AFK_SH"; then r=1; else r=0; fi
expect_true "afk.sh wires on_idle" "$r"

# The on_idle call must live inside the TOTAL==0 branch, before the
# NO MORE TASKS sentinel exit.
on_idle_line="$(grep -n 'hook_dispatch on_idle' "$AFK_SH" | head -1 | cut -d: -f1)"
total_zero_line="$(grep -n 'TOTAL.*-eq 0' "$AFK_SH" | head -1 | cut -d: -f1)"
no_more_line="$(grep -n 'NO MORE TASKS' "$AFK_SH" | head -1 | cut -d: -f1)"
if [[ -n "$on_idle_line" && -n "$total_zero_line" && -n "$no_more_line" \
      && "$total_zero_line" -lt "$on_idle_line" \
      && "$on_idle_line"   -lt "$no_more_line" ]]; then r=1; else r=0; fi
expect_true "on_idle dispatch sits inside empty-queue branch, before exit" "$r"

# ---------- 2. on_idle does NOT fire from the post-loop session-exit path ----------
# The post_session dispatch must come after the main `for n in NUMBERS` loop
# closes. We verify by checking that the only on_idle dispatch lives BEFORE
# the post_session dispatch — the loop-end / session-termination path is
# post_session's responsibility, not on_idle's.
post_session_line="$(grep -n 'hook_dispatch post_session' "$AFK_SH" | head -1 | cut -d: -f1)"
if [[ -n "$on_idle_line" && -n "$post_session_line" \
      && "$on_idle_line" -lt "$post_session_line" ]]; then r=1; else r=0; fi
expect_true "on_idle fires on drain path, distinct from post_session exit path" "$r"

# Stronger: there must be exactly one on_idle dispatch site in afk.sh —
# any second one would risk re-firing on session termination.
on_idle_count="$(grep -c 'hook_dispatch on_idle' "$AFK_SH")"
expect_eq "exactly one on_idle dispatch site in afk.sh" "$on_idle_count" "1"

# ---------- 3. dispatcher policy for on_idle is `continue` ----------
# shellcheck disable=SC1091
source "$DISP_SH"
expect_eq "on_idle policy = continue" "${HOOK_EXIT_POLICY[on_idle]:-}" "continue"

# Canonical name set includes on_idle.
names="$(hook_canonical_names | sort | tr '\n' ',')"
expect_contains "canonical names include on_idle" ",$names" ",on_idle,"

# ---------- 4. cargo-clean example: non-zero is logged, dispatch returns 0 ----------
HOOK_LISTS=()
# Stand-in for `cargo clean -p reddb-storage` that we can run without cargo:
# returns the PRD's intended exit code (non-zero) and a stderr message.
hook_register on_idle 'echo "error: package id specification \`reddb-storage\` did not match any packages" >&2; exit 101'
errlog="$(mktemp)"
out="$(hook_dispatch on_idle '{"runner":"claude","stats":{"done":0,"blocked":0,"total":0}}' 2>"$errlog")"
rc=$?
expect_eq "on_idle non-zero: dispatch rc=0 (continue policy)" "$rc" "0"
expect_eq "on_idle non-zero: ctx unchanged" \
  "$(printf '%s' "$out" | jq -r '.stats.total')" "0"
expect_contains "on_idle non-zero: logged with command rc"   "$(cat "$errlog")" "rc=101"
expect_contains "on_idle non-zero: original stderr surfaced" "$(cat "$errlog")" "reddb-storage"
rm -f "$errlog"

# A second registered command after the failing one still runs (continue policy).
HOOK_LISTS=()
hook_register on_idle 'exit 7'
hook_register on_idle 'printf "%s" "{\"runner\":\"claude\",\"stats\":{\"done\":0,\"blocked\":0,\"total\":0},\"after_fail\":true}"'
out="$(hook_dispatch on_idle '{"runner":"claude","stats":{"done":0,"blocked":0,"total":0}}' 2>/dev/null)"
rc=$?
expect_eq "on_idle: continue runs subsequent cmd after failure (rc=0)" "$rc" "0"
expect_eq "on_idle: subsequent cmd's JSON applied" \
  "$(printf '%s' "$out" | jq -r '.after_fail')" "true"

# ---------- 5. non-empty queue branch is wired NOT to fire on_idle ----------
# Belt-and-braces grep: the on_idle line must NOT appear inside the
# main for-loop or after it. We assert by checking that the on_idle
# dispatch sits before the `for n in "${NUMBERS[@]}"` loop header.
loop_header_line="$(grep -n 'for n in "\${NUMBERS\[@\]}"' "$AFK_SH" | head -1 | cut -d: -f1)"
if [[ -n "$on_idle_line" && -n "$loop_header_line" \
      && "$on_idle_line" -lt "$loop_header_line" ]]; then r=1; else r=0; fi
expect_true "on_idle dispatch precedes the per-issue main loop (non-empty path skips it)" "$r"

# ---------- 6. SKILL.md documents on_idle ----------
SKILL_MD="$HERE/../../SKILL.md"
if grep -q 'on_idle' "$SKILL_MD"; then r=1; else r=0; fi
expect_true "SKILL.md mentions on_idle" "$r"
# Documentation states when it fires (queue drained) and the policy (continue).
if grep -A2 '`on_idle`' "$SKILL_MD" | grep -qi 'drain\|empty\|idle'; then r=1; else r=0; fi
expect_true "SKILL.md explains when on_idle fires" "$r"

echo
echo "summary: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
