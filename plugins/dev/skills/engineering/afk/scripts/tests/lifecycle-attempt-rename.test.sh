#!/usr/bin/env bash
# Tests for the worker→attempt hook rename + per-attempt cadence (issue #226,
# ADR 0026):
#   1. The _afk_fire_pre_attempt / _afk_fire_post_attempt helpers build a
#      context carrying `attempt_n`, export RED_AFK_ATTEMPT_N, and dispatch
#      the canonical pre_attempt / post_attempt names.
#   2. afk.sh fires pre_attempt per runner invocation: two call sites, the
#      second inside the --fallback-runner swap between the two run_inner
#      calls — so a swap yields two pre_attempt → post_attempt cycles.
#   3. Back-compat: a config declaring the old *_worker names still registers
#      its commands under the canonical *_attempt names, with a single
#      deprecation warning logged at load.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
AFK_SH="$HERE/../afk.sh"
CONF_SH="$HERE/../lib/hook-config.sh"

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

# ---------- 1. helper context shape + attempt_n + RED_AFK_ATTEMPT_N ----------
SANDBOX="$(mktemp -d)"
export PROJECT_ROOT="$SANDBOX"
# shellcheck disable=SC1090
source "$AFK_SH"
set +e   # afk.sh enables `set -eo pipefail`; tests need non-zero returns.

CALLS="$(mktemp)"
LAST_CTX="$(mktemp)"
# Stub the dispatcher so the helpers record what they fire without needing a
# real hook chain. Records "<name>|<attempt_n>" and stashes the full ctx.
hook_dispatch() {
  local _name="$1" _ctx="${2:-}"
  printf '%s' "$_ctx" > "$LAST_CTX"
  local _an; _an="$(printf '%s' "$_ctx" | jq -r '.attempt_n // "none"' 2>/dev/null)"
  printf '%s|%s\n' "$_name" "$_an" >> "$CALLS"
  printf '%s' "$_ctx"
}

# Attempt 1 (first runner).
_afk_fire_pre_attempt 42 "Title" /tmp/ws claude 1
expect_eq "pre_attempt: RED_AFK_ATTEMPT_N exported = 1" "${RED_AFK_ATTEMPT_N:-}" "1"
pre_ctx="$(cat "$LAST_CTX")"
expect_eq "pre_attempt ctx: attempt_n = 1" "$(printf '%s' "$pre_ctx" | jq -r '.attempt_n')" "1"
expect_eq "pre_attempt ctx: issue.number = 42" "$(printf '%s' "$pre_ctx" | jq -r '.issue.number')" "42"
expect_eq "pre_attempt ctx: workspace carried" "$(printf '%s' "$pre_ctx" | jq -r '.workspace')" "/tmp/ws"
expect_eq "pre_attempt ctx: runner (read-only) carried" "$(printf '%s' "$pre_ctx" | jq -r '.runner')" "claude"

# Attempt 2 (fallback swap).
_afk_fire_pre_attempt 42 "Title" /tmp/ws codex 2
expect_eq "pre_attempt (swap): RED_AFK_ATTEMPT_N = 2" "${RED_AFK_ATTEMPT_N:-}" "2"

# post_attempt for both attempts.
_afk_fire_post_attempt 42 "Title" /tmp/ws exhausted 1
post1_ctx="$(cat "$LAST_CTX")"
expect_eq "post_attempt ctx: result.status carried" "$(printf '%s' "$post1_ctx" | jq -r '.result.status')" "exhausted"
expect_eq "post_attempt ctx: attempt_n = 1" "$(printf '%s' "$post1_ctx" | jq -r '.attempt_n')" "1"
_afk_fire_post_attempt 42 "Title" /tmp/ws success 2
expect_eq "post_attempt (swap): RED_AFK_ATTEMPT_N = 2" "${RED_AFK_ATTEMPT_N:-}" "2"

calls="$(cat "$CALLS")"
expect_contains "fired pre_attempt with attempt_n=1"  "$calls" "pre_attempt|1"
expect_contains "fired pre_attempt with attempt_n=2"  "$calls" "pre_attempt|2"
expect_contains "fired post_attempt with attempt_n=1" "$calls" "post_attempt|1"
expect_contains "fired post_attempt with attempt_n=2" "$calls" "post_attempt|2"
expect_eq "two pre_attempt firings (per runner invocation)" \
  "$(grep -c '^pre_attempt|' "$CALLS")" "2"
expect_eq "two post_attempt firings (per runner invocation)" \
  "$(grep -c '^post_attempt|' "$CALLS")" "2"

# ADR 0028 / issue #227: the parsed <promise> outcome rides into the
# post_attempt context as result.outcome and the RED_AFK_RESULT_OUTCOME env var.
# (Run after the firing-count assertions above so these extra calls don't skew
# the per-invocation cadence count.)
_afk_fire_post_attempt 42 "Title" /tmp/ws success 2 done
expect_eq "post_attempt ctx: result.outcome carried (done)" \
  "$(printf '%s' "$(cat "$LAST_CTX")" | jq -r '.result.outcome')" "done"
expect_eq "post_attempt: RED_AFK_RESULT_OUTCOME exported (done)" "${RED_AFK_RESULT_OUTCOME:-}" "done"
_afk_fire_post_attempt 42 "Title" /tmp/ws fail 2 blocked
expect_eq "post_attempt ctx: result.outcome carried (blocked)" \
  "$(printf '%s' "$(cat "$LAST_CTX")" | jq -r '.result.outcome')" "blocked"
# Omitting the 6th arg (the exhausted firings) defaults result.outcome to "".
_afk_fire_post_attempt 42 "Title" /tmp/ws exhausted 1
expect_eq "post_attempt ctx: result.outcome defaults empty when omitted" \
  "$(printf '%s' "$(cat "$LAST_CTX")" | jq -r '.result.outcome')" ""

rm -f "$CALLS" "$LAST_CTX"
rm -rf "$SANDBOX"

# ---------- 2. afk.sh wires the fallback pre_attempt between the two runs ----------
ri1="$(grep -n 'run_inner "\$worktree" "\$handoff" "\$RUNNER")"' "$AFK_SH" | sed -n '1p' | cut -d: -f1)"
ri2="$(grep -n 'run_inner "\$worktree" "\$handoff" "\$RUNNER")"' "$AFK_SH" | sed -n '2p' | cut -d: -f1)"
pre2="$(grep -n '_afk_fire_pre_attempt "\$n"' "$AFK_SH" | sed -n '2p' | cut -d: -f1)"
if [[ -n "$ri1" && -n "$ri2" && -n "$pre2" && "$pre2" -gt "$ri1" && "$pre2" -lt "$ri2" ]]; then r=1; else r=0; fi
expect_eq "fallback pre_attempt sits between the two run_inner calls" "$r" "1"

# ---------- 3. back-compat: old *_worker names still fire (translated) ----------
unset PROJECT_ROOT
# shellcheck disable=SC1090
source "$CONF_SH"

mktmp_yaml() {
  local content="$1" f
  f="$(mktemp -t afk-bc.XXXXXX)"
  printf '%s' "$content" > "$f"
  printf '%s' "$f"
}

f="$(mktmp_yaml 'afk:
  hooks:
    pre_worker: "echo legacy-pre"
    post_worker:
      - "echo legacy-post"
    on_worker_error: "echo legacy-err"
')"
HOOK_LISTS=()
HOOK_DEFAULTS_DISABLED=()
warnlog="$(mktemp)"
hook_config_load "$f" 2>"$warnlog"
expect_eq "back-compat load rc=0" "$?" "0"

# Commands land under the canonical names, not the old ones.
expect_contains "pre_worker → registered under pre_attempt"      "${HOOK_LISTS[pre_attempt]:-}"      "echo legacy-pre"
expect_contains "post_worker → registered under post_attempt"    "${HOOK_LISTS[post_attempt]:-}"     "echo legacy-post"
expect_contains "on_worker_error → registered under on_attempt_error" "${HOOK_LISTS[on_attempt_error]:-}" "echo legacy-err"
expect_eq "old pre_worker key not populated"  "${HOOK_LISTS[pre_worker]:-EMPTY}"  "EMPTY"
expect_eq "old post_worker key not populated" "${HOOK_LISTS[post_worker]:-EMPTY}" "EMPTY"

# Exactly one deprecation warning line, naming the renames.
dep_lines="$(grep -c 'deprecated hook name' "$warnlog" || true)"
expect_eq "single deprecation warning logged" "$dep_lines" "1"
expect_contains "deprecation warning names pre_worker→pre_attempt"   "$(cat "$warnlog")" "pre_worker→pre_attempt"
expect_contains "deprecation warning names post_worker→post_attempt" "$(cat "$warnlog")" "post_worker→post_attempt"
rm -f "$f" "$warnlog"

# A config with only canonical names emits NO deprecation warning.
f="$(mktmp_yaml 'afk:
  hooks:
    pre_attempt: "echo modern"
')"
HOOK_LISTS=()
HOOK_DEFAULTS_DISABLED=()
warnlog="$(mktemp)"
hook_config_load "$f" 2>"$warnlog"
expect_eq "canonical-only config: no deprecation warning" \
  "$(grep -c 'deprecated hook name' "$warnlog" || true)" "0"
rm -f "$f" "$warnlog"

echo
echo "summary: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
