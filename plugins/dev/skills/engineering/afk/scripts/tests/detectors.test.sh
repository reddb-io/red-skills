#!/usr/bin/env bash
# Unit tests for the shipped detectors and the pre-spawn boot-log line
# (issue #19). Exercises cargo.sh / gradle.sh directly, then drives
# hooks_run pre-spawn against the real shipped detector directory to
# verify the orchestrator's APPLIED list and config-gating behaviour.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPTS_DIR="$(dirname "$HERE")"
PLUGIN_DIR="$(dirname "$SCRIPTS_DIR")"
DETECTORS_DIR="$PLUGIN_DIR/detectors"
CARGO_SH="$DETECTORS_DIR/cargo.sh"
GRADLE_SH="$DETECTORS_DIR/gradle.sh"

pass=0
fail=0

expect_eq() {
  local label="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    echo "PASS  $label"; pass=$((pass + 1))
  else
    echo "FAIL  $label"; echo "  got:  >>$got<<"; echo "  want: >>$want<<"
    fail=$((fail + 1))
  fi
}

expect_file_exists() {
  local label="$1" path="$2"
  if [[ -e "$path" ]]; then
    echo "PASS  $label"; pass=$((pass + 1))
  else
    echo "FAIL  $label  (missing: $path)"; fail=$((fail + 1))
  fi
}

# ---------- 1. shipped files exist and are executable -----------------------
expect_file_exists "cargo.sh exists" "$CARGO_SH"
expect_file_exists "gradle.sh exists" "$GRADLE_SH"
expect_file_exists "detectors README exists" "$DETECTORS_DIR/README.md"
[[ -x "$CARGO_SH"  ]] && { echo "PASS  cargo.sh executable";  pass=$((pass + 1)); } || { echo "FAIL  cargo.sh not executable";  fail=$((fail + 1)); }
[[ -x "$GRADLE_SH" ]] && { echo "PASS  gradle.sh executable"; pass=$((pass + 1)); } || { echo "FAIL  gradle.sh not executable"; fail=$((fail + 1)); }

# ---------- 2. cargo.sh applicability check ---------------------------------
tmp="$(mktemp -d)"
envfile="$(mktemp)"
rc=0
PROJECT_ROOT="$tmp" AFK_HOOK_ENV_FILE="$envfile" "$CARGO_SH" || rc=$?
expect_eq "cargo: no Cargo.toml → exit 1" "$rc" "1"
expect_eq "cargo: env-file untouched"      "$(wc -c < "$envfile" | tr -d ' ')" "0"
rm -rf "$tmp" "$envfile"

# ---------- 3. cargo.sh applies, writes CARGO_TARGET_DIR with default base --
tmp="$(mktemp -d)"
envfile="$(mktemp)"
: > "$envfile"
touch "$tmp/Cargo.toml"
base="$tmp/base"
rc=0
PROJECT_ROOT="$tmp" AFK_SLOT=0 CARGO_TARGET_BASE="$base" AFK_HOOK_ENV_FILE="$envfile" "$CARGO_SH" || rc=$?
expect_eq "cargo: applies → exit 0" "$rc" "0"
expect_eq "cargo: env-file content" "$(cat "$envfile")" "CARGO_TARGET_DIR=${base}/slot-0"
expect_file_exists "cargo: target dir created" "${base}/slot-0"
rm -rf "$tmp" "$envfile"

# ---------- 4. cargo.sh honours CARGO_TARGET_BASE -----------------------------
tmp="$(mktemp -d)"
envfile="$(mktemp)"
: > "$envfile"
touch "$tmp/Cargo.toml"
custom_base="$tmp/custom"
rc=0
PROJECT_ROOT="$tmp" AFK_SLOT=3 CARGO_TARGET_BASE="$custom_base" AFK_HOOK_ENV_FILE="$envfile" "$CARGO_SH" || rc=$?
expect_eq "cargo: custom base rc"           "$rc" "0"
expect_eq "cargo: custom base env content"  "$(cat "$envfile")" "CARGO_TARGET_DIR=${custom_base}/slot-3"
expect_file_exists "cargo: custom base dir" "${custom_base}/slot-3"
rm -rf "$tmp" "$envfile"

# ---------- 5. gradle.sh — no build.gradle* → exit 1 --------------------------
tmp="$(mktemp -d)"
envfile="$(mktemp)"
rc=0
PROJECT_ROOT="$tmp" AFK_HOOK_ENV_FILE="$envfile" GRADLE_USER_HOME_BASE="$tmp/base" "$GRADLE_SH" || rc=$?
expect_eq "gradle: no build.gradle → exit 1" "$rc" "1"
expect_eq "gradle: env-file untouched"        "$(wc -c < "$envfile" | tr -d ' ')" "0"
rm -rf "$tmp" "$envfile"

# ---------- 6. gradle.sh — present but GRADLE_USER_HOME_BASE unset → exit 1 --
tmp="$(mktemp -d)"
envfile="$(mktemp)"
touch "$tmp/build.gradle"
rc=0
( unset GRADLE_USER_HOME_BASE
  PROJECT_ROOT="$tmp" AFK_HOOK_ENV_FILE="$envfile" "$GRADLE_SH" ) || rc=$?
expect_eq "gradle: base unset → exit 1" "$rc" "1"
rm -rf "$tmp" "$envfile"

# ---------- 7. gradle.sh — applies with build.gradle.kts + base var ----------
tmp="$(mktemp -d)"
envfile="$(mktemp)"
: > "$envfile"
touch "$tmp/build.gradle.kts"
base="$tmp/gradle-home"
rc=0
PROJECT_ROOT="$tmp" AFK_SLOT=1 GRADLE_USER_HOME_BASE="$base" AFK_HOOK_ENV_FILE="$envfile" "$GRADLE_SH" || rc=$?
expect_eq "gradle: applies → exit 0"        "$rc" "0"
expect_eq "gradle: env-file content"        "$(cat "$envfile")" "GRADLE_USER_HOME=${base}/slot-1"
expect_file_exists "gradle: home dir created" "${base}/slot-1"
rm -rf "$tmp" "$envfile"

# ---------- 8. hooks_run pre-spawn applies cargo only when only Cargo.toml --
# Source hooks.sh and config.sh; drive against the real shipped detector dir.
# shellcheck disable=SC1090
source "$SCRIPTS_DIR/config.sh"
# shellcheck disable=SC1090
source "$SCRIPTS_DIR/hooks.sh"

run_pre_spawn_capture() {
  # Run hooks_run pre-spawn in a subshell so detector exports never leak
  # into this test process; echo the space-joined applied list to stdout.
  local proj="$1"
  ( config_load "$proj/.red/config.yaml" >/dev/null 2>&1 || true
    AFK_SLOT=0 \
    AFK_PLUGIN_DIR="$PLUGIN_DIR" \
    PROJECT_ROOT="$proj" \
    hooks_run pre-spawn >/dev/null 2>&1 || true
    printf '%s' "${HOOKS_APPLIED_DETECTORS[*]}"
  )
}

tmp="$(mktemp -d)"
touch "$tmp/Cargo.toml"
CARGO_TARGET_BASE="$tmp/cargo-base" applied="$(CARGO_TARGET_BASE="$tmp/cargo-base" run_pre_spawn_capture "$tmp")"
expect_eq "pre-spawn: cargo-only project" "$applied" "cargo"
rm -rf "$tmp"

# ---------- 9. hooks_run pre-spawn — config-disabled cargo skipped ----------
tmp="$(mktemp -d)"
touch "$tmp/Cargo.toml"
mkdir -p "$tmp/.red"
cat > "$tmp/.red/config.yaml" <<'YAML'
afk:
  hooks:
    defaults:
      cargo: false
YAML
applied="$(CARGO_TARGET_BASE="$tmp/cargo-base" run_pre_spawn_capture "$tmp")"
expect_eq "pre-spawn: cargo disabled via config" "$applied" ""
rm -rf "$tmp"
config_load "/nonexistent/.red/config.yaml" >/dev/null 2>&1 || true

# ---------- 10. hooks_run pre-spawn — neither marker → empty applied --------
tmp="$(mktemp -d)"
applied="$(run_pre_spawn_capture "$tmp")"
expect_eq "pre-spawn: no markers → empty applied" "$applied" ""
rm -rf "$tmp"

# ---------- 11. supervisor.sh + afk.sh wire the boot-log helper -------------
sup_sh="$SCRIPTS_DIR/supervisor.sh"
afk_sh="$SCRIPTS_DIR/afk.sh"
grep -q 'log_applied_detectors_boot_line' "$sup_sh" \
  && { echo "PASS  supervisor.sh wires boot-log helper"; pass=$((pass + 1)); } \
  || { echo "FAIL  supervisor.sh missing boot-log helper"; fail=$((fail + 1)); }
grep -q 'log_applied_detectors_boot_line' "$afk_sh" \
  && { echo "PASS  afk.sh wires boot-log helper"; pass=$((pass + 1)); } \
  || { echo "FAIL  afk.sh missing boot-log helper"; fail=$((fail + 1)); }
grep -q 'pre-spawn: applied detectors' "$sup_sh" \
  && { echo "PASS  supervisor.sh emits canonical boot-line phrase"; pass=$((pass + 1)); } \
  || { echo "FAIL  supervisor.sh missing canonical boot-line phrase"; fail=$((fail + 1)); }
grep -q 'pre-spawn: applied detectors' "$afk_sh" \
  && { echo "PASS  afk.sh emits canonical boot-line phrase"; pass=$((pass + 1)); } \
  || { echo "FAIL  afk.sh missing canonical boot-line phrase"; fail=$((fail + 1)); }

# ---------- summary ---------------------------------------------------------
echo
echo "summary: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
