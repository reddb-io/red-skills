#!/usr/bin/env bash
# Unit test for lib/dev-config.sh — runtime reader for dev.lock-primary-branch.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LIB="$(dirname "$HERE")/lib/dev-config.sh"

# shellcheck source=../lib/dev-config.sh
source "$LIB"

pass=0
fail=0

expect_rc() {
  local label="$1" expected="$2" file="$3"
  dev_config_lock_primary_branch_enabled "$file"
  local actual=$?
  if [[ "$actual" == "$expected" ]]; then
    echo "PASS  $label"; pass=$((pass + 1))
  else
    printf 'FAIL  %s\n      expected rc: %q\n      actual rc:   %q\n' "$label" "$expected" "$actual"
    fail=$((fail + 1))
  fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

missing="$tmp/missing.yaml"
expect_rc "missing file: disabled" 1 "$missing"

cfg="$tmp/config.yaml"

cat > "$cfg" <<'EOF'
dev:
  lock-primary-branch: true
EOF
expect_rc "nested dev flag true: enabled" 0 "$cfg"

cat > "$cfg" <<'EOF'
dev:
  lock-primary-branch: false
EOF
expect_rc "nested dev flag false: disabled" 1 "$cfg"

cat > "$cfg" <<'EOF'
dev:
  lock-primary-branch: "true"
EOF
expect_rc "quoted true: enabled" 0 "$cfg"

cat > "$cfg" <<'EOF'
afk:
  default_runner: codex
EOF
expect_rc "absent key: disabled" 1 "$cfg"

cat > "$cfg" <<'EOF'
dev:
   lock-primary-branch: true
EOF
expect_rc "malformed indentation: disabled" 1 "$cfg"

echo
echo "summary: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
