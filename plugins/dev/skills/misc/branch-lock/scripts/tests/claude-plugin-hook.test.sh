#!/usr/bin/env bash
# Unit test for the Claude plugin PreToolUse(Bash) branch guard wiring.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../../../../.." && pwd)"
MANIFEST="$PLUGIN_ROOT/hooks/claude.hooks.json"

pass=0
fail=0

ok()  { echo "PASS  $1"; pass=$((pass + 1)); }
bad() { echo "FAIL  $1"; fail=$((fail + 1)); }

expect_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    ok "$label"
  else
    bad "$label"
    printf '  expected: %q\n  actual:   %q\n' "$expected" "$actual"
  fi
}

expect_contains() {
  local label="$1" needle="$2" haystack="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    ok "$label"
  else
    bad "$label"
    printf '  missing: %q\n  in:      %q\n' "$needle" "$haystack"
  fi
}

tmp="$(mktemp -d -t branch-lock-claude.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT

primary="$tmp/red-skills"
mkdir -p "$primary/.red"
cat > "$primary/.red/config.yaml" <<'EOF'
plugins:
  dev:
    enabled: true
    lock:
      primary-branch: true
EOF

payload() {
  local cmd="$1"
  jq -nc --arg cmd "$cmd" '{hook_event_name:"PreToolUse", tool_input:{command:$cmd}}'
}

manifest_matcher="$(jq -r '.hooks.PreToolUse[0].matcher' "$MANIFEST")"
manifest_hook="$(jq -r '.hooks.PreToolUse[0].hooks[0].command' "$MANIFEST")"
expect_eq "manifest: matcher is Bash" "Bash" "$manifest_matcher"
expect_contains "manifest: wires branch-lock-hook.sh" "branch-lock-hook.sh" "$manifest_hook"
expect_contains "manifest: wrapper drains stdin before hook" 'cat >"$tmp"' "$manifest_hook"

out="$tmp/out"
err="$tmp/err"
CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" CLAUDE_PROJECT_DIR="$primary" bash -lc "$manifest_hook" \
  >"$out" 2>"$err" <<<"$(payload "git switch feature")"
rc=$?
expect_eq "primary guard: switch is blocked when flag is on" "2" "$rc"
expect_contains "primary guard: error names config flag" "dev.lock.primary-branch is true" "$(<"$err")"

# issue #1024 — git reset (any form) and git stash (all subcommands) blocked,
# and the refusal explains the reason + the sanctioned worktree alternative.
CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" CLAUDE_PROJECT_DIR="$primary" bash -lc "$manifest_hook" \
  >"$out" 2>"$err" <<<"$(payload "git reset --hard")"
rc=$?
expect_eq "primary guard: reset --hard is blocked when flag is on" "2" "$rc"
expect_contains "primary guard: reset refusal points to worktree" ".red/tmp/work-" "$(<"$err")"

CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" CLAUDE_PROJECT_DIR="$primary" bash -lc "$manifest_hook" \
  >"$out" 2>"$err" <<<"$(payload "git stash")"
rc=$?
expect_eq "primary guard: stash is blocked when flag is on" "2" "$rc"

CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" CLAUDE_PROJECT_DIR="$primary" bash -lc "$manifest_hook" \
  >"$out" 2>"$err" <<<"$(payload "git rebase --autostash main")"
rc=$?
expect_eq "primary guard: rebase --autostash is blocked when flag is on" "2" "$rc"

CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" CLAUDE_PROJECT_DIR="$primary" bash -lc "$manifest_hook" \
  >"$out" 2>"$err" <<<"$(payload "git commit -m wip")"
rc=$?
expect_eq "primary guard: commit is allowed" "0" "$rc"

cat > "$primary/.red/config.yaml" <<'EOF'
plugins:
  dev:
    enabled: true
    lock:
      primary-branch: false
EOF
CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" CLAUDE_PROJECT_DIR="$primary" bash -lc "$manifest_hook" \
  >"$out" 2>"$err" <<<"$(payload "git switch feature")"
rc=$?
expect_eq "primary guard: flag off allows switch" "0" "$rc"

missing_root="$tmp/missing-plugin-root"
mkdir -p "$missing_root"
CLAUDE_PLUGIN_ROOT="$missing_root" CLAUDE_PROJECT_DIR="$primary" bash -lc "$manifest_hook" \
  >"$out" 2>"$err" <<<"$(payload "git switch feature")"
rc=$?
expect_eq "manifest: missing hook fails open" "0" "$rc"
expect_eq "manifest: missing hook prints empty JSON" "{}" "$(<"$out")"

echo
echo "summary: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
