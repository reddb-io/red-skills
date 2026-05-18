#!/usr/bin/env bash
# Unit tests for the .red/config.yaml loader (issue #17, PRD #16).
#
# Sources config.sh and drives config_load / config_get against fixture
# files written into a per-test tmpdir.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
CONFIG_SH="$HERE/../config.sh"

# shellcheck disable=SC1090
source "$CONFIG_SH"

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

mktmp() { mktemp -d -t afk-config.XXXXXX; }

# ---------- 1. missing file → all defaults ----------
tmp="$(mktmp)"
config_load "$tmp/.red/config.yaml"
expect_eq "missing: default_runner"        "$(config_get afk.default_runner)"        "claude"
expect_eq "missing: fleet.target"          "$(config_get afk.fleet.target)"          "2"
expect_eq "missing: hooks.defaults.cargo"  "$(config_get afk.hooks.defaults.cargo)"  "true"
expect_eq "missing: hooks.defaults.gradle" "$(config_get afk.hooks.defaults.gradle)" "true"
rm -rf "$tmp"

# ---------- 2. partial overrides only the specified key ----------
tmp="$(mktmp)"
mkdir -p "$tmp/.red"
cat > "$tmp/.red/config.yaml" <<'YAML'
afk:
  default_runner: codex
YAML
config_load "$tmp/.red/config.yaml"
expect_eq "partial: default_runner overridden" "$(config_get afk.default_runner)"        "codex"
expect_eq "partial: fleet.target default kept" "$(config_get afk.fleet.target)"          "2"
expect_eq "partial: cargo default kept"        "$(config_get afk.hooks.defaults.cargo)"  "true"
expect_eq "partial: gradle default kept"       "$(config_get afk.hooks.defaults.gradle)" "true"
rm -rf "$tmp"

# ---------- 3. unknown top-level key is ignored, no warning ----------
tmp="$(mktmp)"
mkdir -p "$tmp/.red"
cat > "$tmp/.red/config.yaml" <<'YAML'
zzz: foo
afk:
  default_runner: codex
YAML
warn_log="$tmp/warn.log"
config_load "$tmp/.red/config.yaml" 2> "$warn_log"
expect_eq "unknown top-level: ignored, defaults preserved" "$(config_get afk.fleet.target)" "2"
expect_eq "unknown top-level: known key still applied"     "$(config_get afk.default_runner)" "codex"
expect_eq "unknown top-level: no warning emitted"          "$(wc -l < "$warn_log" | tr -d ' ')" "0"
rm -rf "$tmp"

# ---------- 4. unknown nested key is ignored silently ----------
tmp="$(mktmp)"
mkdir -p "$tmp/.red"
cat > "$tmp/.red/config.yaml" <<'YAML'
afk:
  default_runner: codex
  unknown_thing: 42
YAML
warn_log="$tmp/warn.log"
config_load "$tmp/.red/config.yaml" 2> "$warn_log"
expect_eq "unknown nested: known key applied"   "$(config_get afk.default_runner)" "codex"
expect_eq "unknown nested: defaults preserved"  "$(config_get afk.fleet.target)"   "2"
expect_eq "unknown nested: no warning emitted"  "$(wc -l < "$warn_log" | tr -d ' ')" "0"
rm -rf "$tmp"

# ---------- 5. malformed YAML → one warning, all defaults ----------
tmp="$(mktmp)"
mkdir -p "$tmp/.red"
# Unclosed quote → malformed
cat > "$tmp/.red/config.yaml" <<'YAML'
afk:
  default_runner: "codex
YAML
warn_log="$tmp/warn.log"
config_load "$tmp/.red/config.yaml" 2> "$warn_log"
expect_eq "malformed: default_runner fell back" "$(config_get afk.default_runner)" "claude"
expect_eq "malformed: fleet.target fell back"   "$(config_get afk.fleet.target)"   "2"
expect_eq "malformed: emits exactly one warning line" "$(wc -l < "$warn_log" | tr -d ' ')" "1"
expect_eq "malformed: warning mentions config.yaml"   \
  "$(grep -c 'config.yaml' "$warn_log" | tr -d ' ')" "1"
rm -rf "$tmp"

# Broken indentation → malformed (odd indent on a child)
tmp="$(mktmp)"
mkdir -p "$tmp/.red"
cat > "$tmp/.red/config.yaml" <<'YAML'
afk:
   default_runner: codex
YAML
warn_log="$tmp/warn.log"
config_load "$tmp/.red/config.yaml" 2> "$warn_log"
expect_eq "bad-indent: default_runner fell back" "$(config_get afk.default_runner)" "claude"
expect_eq "bad-indent: emits exactly one warning" "$(wc -l < "$warn_log" | tr -d ' ')" "1"
rm -rf "$tmp"

# ---------- 6. every documented v1 key has a default ----------
config_load "/nonexistent/path/.red/config.yaml"
for key in \
  afk.default_runner \
  afk.fleet.target \
  afk.hooks.defaults.cargo \
  afk.hooks.defaults.gradle
do
  val="$(config_get "$key")"
  if [[ -n "$val" ]]; then
    echo "PASS  documented default present: $key=$val"
    pass=$((pass + 1))
  else
    echo "FAIL  documented default missing: $key"
    fail=$((fail + 1))
  fi
done

# ---------- 7. nested overrides leave siblings untouched ----------
tmp="$(mktmp)"
mkdir -p "$tmp/.red"
cat > "$tmp/.red/config.yaml" <<'YAML'
afk:
  hooks:
    defaults:
      cargo: false
YAML
config_load "$tmp/.red/config.yaml"
expect_eq "nested override: cargo flipped"  "$(config_get afk.hooks.defaults.cargo)"  "false"
expect_eq "nested override: gradle default" "$(config_get afk.hooks.defaults.gradle)" "true"
expect_eq "nested override: fleet untouched" "$(config_get afk.fleet.target)" "2"
rm -rf "$tmp"

# ---------- 8. integer values round-trip ----------
tmp="$(mktmp)"
mkdir -p "$tmp/.red"
cat > "$tmp/.red/config.yaml" <<'YAML'
afk:
  fleet:
    target: 5
YAML
config_load "$tmp/.red/config.yaml"
expect_eq "integer override: fleet.target=5" "$(config_get afk.fleet.target)" "5"
rm -rf "$tmp"

# ---------- 9. comments and blank lines ignored ----------
tmp="$(mktmp)"
mkdir -p "$tmp/.red"
cat > "$tmp/.red/config.yaml" <<'YAML'
# top-level comment
afk:
  # inner comment
  default_runner: codex

  fleet:
    target: 3   # inline comment
YAML
warn_log="$tmp/warn.log"
config_load "$tmp/.red/config.yaml" 2> "$warn_log"
expect_eq "comments: default_runner"  "$(config_get afk.default_runner)" "codex"
expect_eq "comments: fleet.target"    "$(config_get afk.fleet.target)"   "3"
expect_eq "comments: no warning"      "$(wc -l < "$warn_log" | tr -d ' ')" "0"
rm -rf "$tmp"

# ---------- 10. loader callable from afk.sh and supervisor.sh ----------
# Sourcing both scripts (which themselves source config.sh) must not
# blow up and must leave config_get callable.
afk_sh="$HERE/../afk.sh"
sup_sh="$HERE/../supervisor.sh"

if grep -q 'config\.sh' "$afk_sh"; then
  echo "PASS  afk.sh sources config.sh"
  pass=$((pass + 1))
else
  echo "FAIL  afk.sh does not source config.sh"
  fail=$((fail + 1))
fi

if grep -q 'config\.sh' "$sup_sh"; then
  echo "PASS  supervisor.sh sources config.sh"
  pass=$((pass + 1))
else
  echo "FAIL  supervisor.sh does not source config.sh"
  fail=$((fail + 1))
fi

# ---------- summary ----------
echo
echo "summary: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
