#!/usr/bin/env bash
# Integration sanity for pre_session / post_session wiring inside afk.sh
# (issue #208). Verifies the script sources the new modules and that the
# observable contract (env-var population + exit-code policy) holds end to
# end against the dispatcher. Does NOT run the full /afk main loop —
# afk.sh's source guard exits early when sourced, exposing functions for
# isolated checks.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
AFK_SH="$HERE/../afk.sh"
DISP_SH="$HERE/../lib/hook-dispatcher.sh"
CONF_SH="$HERE/../lib/hook-config.sh"

pass=0
fail=0

expect_true() {
  local label="$1" cond="$2"
  if [[ "$cond" == "1" ]]; then
    echo "PASS  $label"; pass=$((pass + 1))
  else
    echo "FAIL  $label"; fail=$((fail + 1))
  fi
}

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

# ---------- 1. afk.sh sources the new dispatcher and loader ----------
if grep -q 'hook-dispatcher\.sh' "$AFK_SH"; then r=1; else r=0; fi
expect_true "afk.sh sources hook-dispatcher.sh" "$r"
if grep -q 'hook-config\.sh' "$AFK_SH"; then r=1; else r=0; fi
expect_true "afk.sh sources hook-config.sh" "$r"

# ---------- 2. afk.sh actually dispatches pre_session / post_session ----------
if grep -q 'hook_dispatch pre_session'  "$AFK_SH"; then r=1; else r=0; fi
expect_true "afk.sh wires pre_session"  "$r"
if grep -q 'hook_dispatch post_session' "$AFK_SH"; then r=1; else r=0; fi
expect_true "afk.sh wires post_session" "$r"

# ---------- 3. config block from .red/config.yaml drives dispatch ----------
tmp_root="$(mktemp -d)"
mkdir -p "$tmp_root/.red"
cat > "$tmp_root/.red/config.yaml" <<'YAML'
afk:
  hooks:
    pre_session: "jq --arg r \"$RED_AFK_RUNNER\" '.runner = $r + \"-tagged\"'"
    post_session:
      - "echo log line"
      - "exit 0"
YAML

# shellcheck disable=SC1091
source "$DISP_SH"
# shellcheck disable=SC1091
source "$CONF_SH"
HOOK_LISTS=()
hook_config_load "$tmp_root/.red/config.yaml"
expect_eq "config-from-yaml: load rc=0" "$?" "0"
expect_eq "config-from-yaml: pre_session registered" \
  "${HOOK_LISTS[pre_session]:-NONE}" \
  "jq --arg r \"\$RED_AFK_RUNNER\" '.runner = \$r + \"-tagged\"'"
expect_eq "config-from-yaml: post_session has 2 cmds" \
  "$(printf '%s\n' "${HOOK_LISTS[post_session]}" | wc -l | tr -d ' ')" "2"

# Dispatch and verify env var threaded through.
out="$(RED_AFK_RUNNER=claude hook_dispatch pre_session '{}' 2>/dev/null)"
expect_eq "dispatch: env var visible to hook" \
  "$(printf '%s' "$out" | jq -r '.runner')" "claude-tagged"
rm -rf "$tmp_root"

# ---------- 4. unknown hook name from yaml aborts session boot ----------
tmp_root="$(mktemp -d)"
mkdir -p "$tmp_root/.red"
cat > "$tmp_root/.red/config.yaml" <<'YAML'
afk:
  hooks:
    pre_typo_here: "echo nope"
YAML
HOOK_LISTS=()
hook_config_load "$tmp_root/.red/config.yaml" 2>/dev/null
rc=$?
expect_eq "unknown hook at boot: rc != 0" "$([[ $rc -ne 0 ]] && echo 1 || echo 0)" "1"
rm -rf "$tmp_root"

# ---------- 5. bare-string shorthand still produces a runnable list ----------
tmp_root="$(mktemp -d)"
mkdir -p "$tmp_root/.red"
cat > "$tmp_root/.red/config.yaml" <<'YAML'
afk:
  hooks:
    post_session: "true"
YAML
HOOK_LISTS=()
hook_config_load "$tmp_root/.red/config.yaml"
expect_eq "bare-string shorthand: one cmd"  "${HOOK_LISTS[post_session]:-}" "true"
hook_dispatch post_session '{"ok":true}' >/dev/null
expect_eq "bare-string shorthand: dispatch rc=0" "$?" "0"
rm -rf "$tmp_root"

echo
echo "summary: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
