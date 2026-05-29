#!/usr/bin/env bash
# Tests for plugins/.../afk/scripts/lib/reaper-signal.sh (issue #248).
#
# Sources the module directly (no orchestrator globals, no ps/pstree) and
# exercises the busy-vs-stuck decision the acceptance criteria name:
#   - busy (no-kill) when an active build/test descendant exists, even
#     though the agent lane is silent past the threshold;
#   - busy (no-kill) when cpu indicates active work despite that silence;
#   - stuck (kill) only when idle past threshold AND no active descendant
#     AND flat cpu;
#   - the decision is pure — a function of its inputs, no I/O.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPTS="$(dirname "$HERE")"
LIB="$SCRIPTS/lib/reaper-signal.sh"

# shellcheck source=../lib/reaper-signal.sh
source "$LIB"

pass=0
fail=0

expect_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "PASS  $label"
    pass=$((pass + 1))
  else
    printf 'FAIL  %s\n      expected: %q\n      actual:   %q\n' "$label" "$expected" "$actual"
    fail=$((fail + 1))
  fi
}

expect_ok() {
  local label="$1"; shift
  if "$@"; then
    echo "PASS  $label"
    pass=$((pass + 1))
  else
    echo "FAIL  $label (command failed: $*)"
    fail=$((fail + 1))
  fi
}

expect_not_ok() {
  local label="$1"; shift
  if "$@"; then
    echo "FAIL  $label (command unexpectedly succeeded: $*)"
    fail=$((fail + 1))
  else
    echo "PASS  $label"
    pass=$((pass + 1))
  fi
}

# Fixed inputs throughout: threshold 600s, default cpu-busy line (5%).
THRESH=600

# ---------- AC1: active build/test descendant ⇒ busy, never killed ----------

# Idle well past the threshold, flat cpu, but a descendant is running.
expect_eq "AC1 active descendant ⇒ no-kill" "no-kill" \
  "$(reaper_signal_decide 9999 "$THRESH" 1 0)"

# The active flag is honoured in its common spellings.
expect_eq "AC1 active=yes ⇒ no-kill"  "no-kill" "$(reaper_signal_decide 9999 "$THRESH" yes 0)"
expect_eq "AC1 active=true ⇒ no-kill" "no-kill" "$(reaper_signal_decide 9999 "$THRESH" true 0)"

# Active descendant outranks flat cpu — a build can sit at ~0% (blocked on I/O)
# yet still be live; the descendant alone protects it.
expect_eq "AC1 active beats flat cpu" "no-kill" \
  "$(reaper_signal_decide 9999 "$THRESH" 1 0.0)"

# ---------- AC2: non-trivial cpu ⇒ busy, never killed ----------

# Idle past threshold, no descendant, but cpu is non-trivial.
expect_eq "AC2 high cpu ⇒ no-kill"   "no-kill" "$(reaper_signal_decide 9999 "$THRESH" 0 73.4)"
expect_eq "AC2 float cpu 12.5 ⇒ no-kill" "no-kill" "$(reaper_signal_decide 9999 "$THRESH" no 12.5)"

# cpu exactly at the busy line counts as busy (ambiguity favours no-kill).
expect_eq "AC2 cpu == busy line ⇒ no-kill" "no-kill" "$(reaper_signal_decide 9999 "$THRESH" 0 5)"

# A custom busy line is honoured.
expect_eq "AC2 custom busy line, cpu above ⇒ no-kill" "no-kill" \
  "$(reaper_signal_decide 9999 "$THRESH" 0 2.0 1.5)"

# ---------- AC3: kill only when idle past threshold AND no descendant AND flat cpu ----------

expect_eq "AC3 idle+no-descendant+flat cpu ⇒ kill" "kill" \
  "$(reaper_signal_decide 9999 "$THRESH" 0 0)"

# Falsy descendant spellings do not protect a flat-cpu worker.
expect_eq "AC3 active=no ⇒ kill"    "kill" "$(reaper_signal_decide 9999 "$THRESH" no 0)"
expect_eq "AC3 active=false ⇒ kill" "kill" "$(reaper_signal_decide 9999 "$THRESH" false 0)"
expect_eq "AC3 active='' ⇒ kill"    "kill" "$(reaper_signal_decide 9999 "$THRESH" "" 0)"

# Trivial-but-nonzero cpu below the busy line is still flat → kill.
expect_eq "AC3 cpu 0.3 below line ⇒ kill" "kill" "$(reaper_signal_decide 9999 "$THRESH" 0 0.3)"

# cpu just below a custom busy line ⇒ kill.
expect_eq "AC3 cpu below custom line ⇒ kill" "kill" \
  "$(reaper_signal_decide 9999 "$THRESH" 0 1.4 1.5)"

# ---------- boundary: the idle-vs-threshold edge ----------

# Within the grace window — not idle long enough — is never killed, even with
# no descendant and flat cpu.
expect_eq "idle below threshold ⇒ no-kill" "no-kill" \
  "$(reaper_signal_decide 599 "$THRESH" 0 0)"

# Exactly at the threshold counts as "past" (>=), like compute_stalled.
expect_eq "idle == threshold ⇒ kill" "kill" "$(reaper_signal_decide 600 "$THRESH" 0 0)"
expect_eq "idle == threshold-1 ⇒ no-kill" "no-kill" "$(reaper_signal_decide 599 "$THRESH" 0 0)"

# ---------- boundary: the cpu-busy edge ----------

# Just under the default busy line ⇒ kill; just over ⇒ no-kill.
expect_eq "cpu just under busy ⇒ kill"   "kill"    "$(reaper_signal_decide 9999 "$THRESH" 0 4.999)"
expect_eq "cpu just over busy ⇒ no-kill" "no-kill" "$(reaper_signal_decide 9999 "$THRESH" 0 5.001)"

# ---------- fail-safe: unparseable inputs favour NOT killing ----------

# A non-numeric / empty threshold means we cannot say the worker is "past"
# anything, so we never kill on it.
expect_eq "non-numeric threshold ⇒ no-kill" "no-kill" "$(reaper_signal_decide 9999 abc 0 0)"
expect_eq "empty threshold ⇒ no-kill"       "no-kill" "$(reaper_signal_decide 9999 "" 0 0)"

# Non-numeric idle is treated as 0 (never past a positive threshold) ⇒ no-kill.
expect_eq "non-numeric idle ⇒ no-kill" "no-kill" "$(reaper_signal_decide xyz "$THRESH" 0 0)"

# Non-numeric cpu is treated as 0 (flat) — past threshold, no descendant ⇒ kill.
expect_eq "non-numeric cpu ⇒ flat ⇒ kill" "kill" "$(reaper_signal_decide 9999 "$THRESH" 0 notanumber)"

# ---------- contract: always returns 0 ----------

expect_ok "always returns 0 (kill branch)"        reaper_signal_decide 9999 "$THRESH" 0 0
expect_ok "always returns 0 (busy branch)"        reaper_signal_decide 9999 "$THRESH" 1 0
expect_ok "always returns 0 (grace branch)"       reaper_signal_decide 1 "$THRESH" 0 0
expect_ok "always returns 0 (bad-threshold branch)" reaper_signal_decide 9999 abc 0 0

# ---------- helper predicates are pure text ----------

expect_ok     "_reaper_truthy true on 1"      _reaper_truthy 1
expect_ok     "_reaper_truthy true on YES"    _reaper_truthy YES
expect_not_ok "_reaper_truthy false on 0"     _reaper_truthy 0
expect_not_ok "_reaper_truthy false on ''"    _reaper_truthy ""
expect_ok     "_reaper_is_uint true on 600"   _reaper_is_uint 600
expect_not_ok "_reaper_is_uint false on 6.0"  _reaper_is_uint 6.0
expect_not_ok "_reaper_is_uint false on x"    _reaper_is_uint x
expect_ok     "_reaper_cpu_busy 5>=5"         _reaper_cpu_busy 5 5
expect_ok     "_reaper_cpu_busy 12.5>=5"      _reaper_cpu_busy 12.5 5
expect_not_ok "_reaper_cpu_busy 4.9>=5"       _reaper_cpu_busy 4.9 5

# ---------- summary ----------
echo
echo "reaper-signal: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
