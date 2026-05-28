#!/usr/bin/env bash
# Tests for hook-config.sh — afk.hooks loader (issue #208, PRD #207).

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/../lib/hook-config.sh"

pass=0
fail=0

expect_eq() {
  local label="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    echo "PASS  $label"
    pass=$((pass + 1))
  else
    echo "FAIL  $label"
    echo "  got:  >>$got<<"
    echo "  want: >>$want<<"
    fail=$((fail + 1))
  fi
}

mktmp_yaml() {
  local content="$1"
  local f
  f="$(mktemp -t afk-hook-config.XXXXXX)"
  printf '%s' "$content" > "$f"
  printf '%s' "$f"
}

# ---------- 1. missing file → loads cleanly, no hooks ----------
HOOK_LISTS=()
hook_config_load "/nonexistent/.red/config.yaml"
rc=$?
expect_eq "missing file: rc=0" "$rc" "0"
expect_eq "missing file: no pre_session" "${HOOK_LISTS[pre_session]:-EMPTY}" "EMPTY"

# ---------- 2. bare-string shorthand → one-element list ----------
f="$(mktmp_yaml 'afk:
  hooks:
    pre_session: "echo boot"
')"
HOOK_LISTS=()
hook_config_load "$f"
expect_eq "bare string: rc=0" "$?" "0"
expect_eq "bare string: registered" "${HOOK_LISTS[pre_session]:-}" "echo boot"
rm -f "$f"

# ---------- 3. block list with multiple commands ----------
f="$(mktmp_yaml 'afk:
  hooks:
    post_session:
      - "echo one"
      - "echo two"
      - "echo three"
')"
HOOK_LISTS=()
hook_config_load "$f"
expect_eq "block list: three commands" \
  "$(printf '%s\n' "${HOOK_LISTS[post_session]}" | wc -l | tr -d ' ')" "3"
expect_eq "block list: first cmd"  "$(printf '%s\n' "${HOOK_LISTS[post_session]}" | sed -n 1p)" "echo one"
expect_eq "block list: third cmd"  "$(printf '%s\n' "${HOOK_LISTS[post_session]}" | sed -n 3p)" "echo three"
rm -f "$f"

# ---------- 4. unknown hook name → hard error at boot (rc=3) ----------
f="$(mktmp_yaml 'afk:
  hooks:
    pre_doesnotexist: "echo nope"
')"
HOOK_LISTS=()
hook_config_load "$f" 2>/dev/null
rc=$?
expect_eq "unknown hook name: rc=3" "$rc" "3"
rm -f "$f"

# ---------- 5. unknown hook in block list also rc=3 ----------
f="$(mktmp_yaml 'afk:
  hooks:
    on_explosion:
      - "echo boom"
')"
HOOK_LISTS=()
hook_config_load "$f" 2>/dev/null
rc=$?
expect_eq "unknown hook (block list): rc=3" "$rc" "3"
rm -f "$f"

# ---------- 6. defaults.<name>: false → recorded in HOOK_DEFAULTS_DISABLED ----------
f="$(mktmp_yaml 'afk:
  hooks:
    defaults:
      cargo: false
      gradle: true
')"
HOOK_LISTS=()
hook_config_load "$f"
expect_eq "defaults toggle: cargo disabled"      "${HOOK_DEFAULTS_DISABLED[cargo]:-}"  "1"
expect_eq "defaults toggle: gradle not disabled" "${HOOK_DEFAULTS_DISABLED[gradle]:-NONE}" "NONE"
rm -f "$f"

# ---------- 7. mixed bare-string and block-list in same file ----------
f="$(mktmp_yaml 'afk:
  hooks:
    pre_session: "echo first"
    post_session:
      - "echo a"
      - "echo b"
')"
HOOK_LISTS=()
hook_config_load "$f"
expect_eq "mixed: pre_session bare"  "${HOOK_LISTS[pre_session]:-}" "echo first"
expect_eq "mixed: post_session lines" \
  "$(printf '%s\n' "${HOOK_LISTS[post_session]}" | wc -l | tr -d ' ')" "2"
rm -f "$f"

# ---------- 8. unrelated top-level keys don't interfere ----------
f="$(mktmp_yaml 'afk:
  default_runner: claude
  fleet:
    target: 4
  hooks:
    pre_session: "echo present"
other_top:
  ignored: true
')"
HOOK_LISTS=()
hook_config_load "$f"
expect_eq "ignores unrelated keys: pre_session present" \
  "${HOOK_LISTS[pre_session]:-}" "echo present"
rm -f "$f"

# ---------- 9. declaration order preserved within a hook list ----------
f="$(mktmp_yaml 'afk:
  hooks:
    post_session:
      - "first"
      - "second"
      - "third"
      - "fourth"
')"
HOOK_LISTS=()
hook_config_load "$f"
expect_eq "order preserved" \
  "$(printf '%s' "${HOOK_LISTS[post_session]}" | tr '\n' ',')" "first,second,third,fourth"
rm -f "$f"

echo
echo "summary: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
