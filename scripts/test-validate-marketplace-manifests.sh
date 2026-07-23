#!/usr/bin/env bash
# Fixture-based test for scripts/validate-marketplace-manifests.sh.
#
# Starts from one valid marketplace tree, mutates copies for each failure rule,
# and asserts the expected pass/fail outcome.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VALIDATOR="scripts/validate-marketplace-manifests.sh"
FIX_ROOT="scripts/fixtures/marketplace-manifests/valid/basic"
OUT=/tmp/.marketplace-manifests-out

[ -x "$VALIDATOR" ] || {
  printf 'error: %s is not executable\n' "$VALIDATOR" >&2
  exit 1
}

command -v jq >/dev/null || {
  printf 'error: jq is required\n' >&2
  exit 1
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp" "$OUT"' EXIT

fail_count=0
pass_count=0

make_case() {
  local label="$1"
  local dest="$tmp/$label"
  mkdir -p "$dest"
  cp -R "$FIX_ROOT"/. "$dest"/
  printf '%s\n' "$dest"
}

expect_pass() {
  local label="$1"
  local root
  root="$(make_case "$label")"
  if "$VALIDATOR" --root "$root" >"$OUT" 2>&1; then
    printf 'PASS  valid/%s\n' "$label"
    pass_count=$((pass_count + 1))
  else
    printf 'FAIL  valid/%s - expected pass, got fail:\n' "$label" >&2
    sed 's/^/      /' "$OUT" >&2
    fail_count=$((fail_count + 1))
  fi
}

expect_fail() {
  local label="$1"
  local needle="$2"
  shift 2
  local root
  root="$(make_case "$label")"
  "$@" "$root"
  if "$VALIDATOR" --root "$root" >"$OUT" 2>&1; then
    printf 'FAIL  invalid/%s - expected fail, got pass\n' "$label" >&2
    fail_count=$((fail_count + 1))
    return
  fi
  if ! grep -q "$needle" "$OUT"; then
    printf 'FAIL  invalid/%s - failed but missing expected text %q\n' "$label" "$needle" >&2
    sed 's/^/      /' "$OUT" >&2
    fail_count=$((fail_count + 1))
    return
  fi
  printf 'PASS  invalid/%s\n' "$label"
  pass_count=$((pass_count + 1))
}

missing_plugin_dir() {
  rm -rf "$1/plugins/beta"
}

missing_plugin_manifest() {
  rm -f "$1/plugins/alpha/.claude-plugin/plugin.json"
}

malformed_plugin_manifest() {
  printf '{\n' > "$1/plugins/alpha/.codex-plugin/plugin.json"
  printf '{\n' > "$1/plugins/alpha/.gemini-plugin/plugin.json"
}

missing_manifest_field() {
  jq 'del(.version)' "$1/plugins/alpha/.claude-plugin/plugin.json" > "$1/plugin.tmp"
  mv "$1/plugin.tmp" "$1/plugins/alpha/.claude-plugin/plugin.json"
}

skill_without_skill_md() {
  mkdir -p "$1/plugins/alpha/skills/core/missing-skill"
}

plugin_set_mismatch() {
  jq 'del(.plugins[] | select(.name == "beta"))' "$1/.agents/plugins/marketplace.json" > "$1/marketplace.tmp"
  mv "$1/marketplace.tmp" "$1/.agents/plugins/marketplace.json"
  jq 'del(.plugins[] | select(.name == "beta"))' "$1/.gemini-plugin/marketplace.json" > "$1/marketplace2.tmp"
  mv "$1/marketplace2.tmp" "$1/.gemini-plugin/marketplace.json"
}

expect_pass basic
expect_fail missing-plugin-dir       "plugin directory not found"       missing_plugin_dir
expect_fail missing-plugin-manifest  "plugin manifest not found"        missing_plugin_manifest
expect_fail malformed-manifest       "malformed plugin manifest"        malformed_plugin_manifest
expect_fail missing-required-field   "missing required field"           missing_manifest_field
expect_fail skill-without-skill-md   "skill directory missing SKILL.md" skill_without_skill_md
expect_fail plugin-set-mismatch      "marketplace plugin set mismatch"  plugin_set_mismatch

if [ "$fail_count" -ne 0 ]; then
  printf '\n%d failed, %d passed\n' "$fail_count" "$pass_count" >&2
  exit 1
fi
printf '\nall %d marketplace-manifest fixtures pass\n' "$pass_count"
