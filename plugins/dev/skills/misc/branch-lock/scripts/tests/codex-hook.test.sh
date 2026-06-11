#!/usr/bin/env bash
# Unit test for the Codex plugin PreToolUse branch-lock hook.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../../../../.." && pwd)"
HOOK="$PLUGIN_ROOT/hooks/branch-lock-codex.sh"
MANIFEST="$PLUGIN_ROOT/hooks/codex.hooks.json"

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

tmp="$(mktemp -d -t branch-lock-codex.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT

primary="$tmp/red-skills"
mkdir -p "$primary/.red/tmp"
printf 'main\n' > "$primary/.red/tmp/branch-lock.yaml"

run_hook() {
  local root="$1" payload="$2" out err rc
  out="$tmp/out"
  err="$tmp/err"
  CODEX_PLUGIN_ROOT="$PLUGIN_ROOT" "$HOOK" >"$out" 2>"$err" <<<"$payload"
  rc=$?
  printf '%s\n---stdout---\n%s\n---stderr---\n%s\n' "$rc" "$(<"$out")" "$(<"$err")"
}

payload() {
  local root="$1" cmd="$2"
  jq -nc --arg cwd "$root" --arg cmd "$cmd" \
    '{hook_event_name:"PreToolUse", cwd:$cwd, tool_input:{cmd:$cmd}}'
}

manifest_hook="$(jq -r '.hooks.PreToolUse[0].hooks[0].command' "$MANIFEST")"
expect_contains "manifest: wires branch-lock-codex.sh" "branch-lock-codex.sh" "$manifest_hook"
expect_contains "manifest: wrapper drains stdin before hook" 'cat >"$tmp"' "$manifest_hook"

out="$tmp/manifest-out"
err="$tmp/manifest-err"
CODEX_PLUGIN_ROOT="$PLUGIN_ROOT" bash -lc "$manifest_hook" >"$out" 2>"$err" \
  <<<"$(payload "$primary" "git switch main")"
rc=$?
expect_eq "manifest: command executes through shell" "0" "$rc"
expect_eq "manifest: command prints empty JSON" "{}" "$(<"$out")"

missing_root="$tmp/missing-plugin-root"
mkdir -p "$missing_root"
CODEX_PLUGIN_ROOT="$missing_root" bash -lc "$manifest_hook" >"$out" 2>"$err" \
  <<<"$(payload "$primary" "git switch main")"
rc=$?
expect_eq "manifest: missing hook fails open" "0" "$rc"
expect_eq "manifest: missing hook prints empty JSON" "{}" "$(<"$out")"

early_root="$tmp/early-plugin-root"
mkdir -p "$early_root/hooks"
cat > "$early_root/hooks/branch-lock-codex.sh" <<'EOF'
#!/usr/bin/env sh
printf '{}'
exit 0
EOF
chmod +x "$early_root/hooks/branch-lock-codex.sh"
set -o pipefail
(head -c 1048576 /dev/zero | tr '\0' x) \
  | CODEX_PLUGIN_ROOT="$early_root" bash -lc "$manifest_hook" >"$out" 2>"$err"
rc=$?
set +o pipefail
expect_eq "manifest: early hook still drains Codex stdin" "0" "$rc"
expect_eq "manifest: early hook prints empty JSON" "{}" "$(<"$out")"

CODEX_PLUGIN_ROOT="$missing_root" "$HOOK" >"$out" 2>"$err" \
  <<<"$(payload "$primary" "git switch main")"
rc=$?
expect_eq "hook: incomplete plugin root fails open" "0" "$rc"
expect_eq "hook: incomplete plugin root prints empty JSON" "{}" "$(<"$out")"

result="$(run_hook "$primary" "$(payload "$primary" "git switch feature")")"
rc="$(sed -n '1p' <<<"$result")"
stderr="$(sed -n '/---stderr---/,$p' <<<"$result")"
expect_eq "locked: switch away is blocked" "2" "$rc"
expect_contains "locked: error names branch lock" "BLOCKED by branch lock" "$stderr"

result="$(run_hook "$primary" "$(payload "$primary" "git switch main")")"
rc="$(sed -n '1p' <<<"$result")"
stdout="$(sed -n '/---stdout---/,/---stderr---/p' <<<"$result" | sed '1d;$d')"
expect_eq "locked: switch back is allowed" "0" "$rc"
expect_eq "locked: allowed prints empty JSON" "{}" "$stdout"

rm -f "$primary/.red/tmp/branch-lock.yaml"
result="$(run_hook "$primary" "$(payload "$primary" "git switch feature")")"
rc="$(sed -n '1p' <<<"$result")"
expect_eq "unlocked: switch is allowed" "0" "$rc"

mkdir -p "$primary/.red"
cat > "$primary/.red/config.yaml" <<'EOF'
dev:
  lock:
    primary-branch: true
EOF

result="$(run_hook "$primary" "$(payload "$primary" "git switch feature")")"
rc="$(sed -n '1p' <<<"$result")"
stderr="$(sed -n '/---stderr---/,$p' <<<"$result")"
expect_eq "primary guard: switch is blocked when flag is on" "2" "$rc"
expect_contains "primary guard: error names config flag" "dev.lock.primary-branch is true" "$stderr"

result="$(run_hook "$primary" "$(payload "$primary" "git checkout feature")")"
rc="$(sed -n '1p' <<<"$result")"
expect_eq "primary guard: checkout branch is blocked when flag is on" "2" "$rc"

result="$(run_hook "$primary" "$(payload "$primary" "git switch -b new")")"
rc="$(sed -n '1p' <<<"$result")"
expect_eq "primary guard: switch -b is blocked when flag is on" "2" "$rc"

result="$(run_hook "$primary" "$(payload "$primary" "git commit -m wip")")"
rc="$(sed -n '1p' <<<"$result")"
expect_eq "primary guard: commit is allowed" "0" "$rc"

result="$(run_hook "$primary" "$(payload "$primary" "git worktree add ../wt feature")")"
rc="$(sed -n '1p' <<<"$result")"
expect_eq "primary guard: worktree add is allowed" "0" "$rc"

result="$(run_hook "$primary" "$(payload "$primary" "git status")")"
rc="$(sed -n '1p' <<<"$result")"
expect_eq "primary guard: read-only git is allowed" "0" "$rc"

cat > "$primary/.red/config.yaml" <<'EOF'
dev:
  lock:
    primary-branch: false
EOF
result="$(run_hook "$primary" "$(payload "$primary" "git switch feature")")"
rc="$(sed -n '1p' <<<"$result")"
expect_eq "primary guard: switch is allowed when flag is off" "0" "$rc"

worktree="$primary/.red/tmp/work-wAAAA-i1/worktree"
mkdir -p "$worktree" "$primary/.red/tmp"
printf 'main\n' > "$primary/.red/tmp/branch-lock.yaml"
result="$(run_hook "$worktree" "$(payload "$worktree" "git switch feature")")"
rc="$(sed -n '1p' <<<"$result")"
expect_eq "worktree: branch lock is exempt" "0" "$rc"

mkdir -p "$worktree/.red"
cat > "$worktree/.red/config.yaml" <<'EOF'
dev:
  lock:
    primary-branch: true
EOF
result="$(run_hook "$worktree" "$(payload "$worktree" "git switch feature")")"
rc="$(sed -n '1p' <<<"$result")"
expect_eq "worktree: primary guard is exempt" "0" "$rc"

result="$(run_hook "$primary" "$(jq -nc --arg cwd "$primary" '{hook_event_name:"PreToolUse", cwd:$cwd, tool_input:{file:"x"}}')")"
rc="$(sed -n '1p' <<<"$result")"
expect_eq "non-shell payload: no-op allowed" "0" "$rc"

echo
echo "summary: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
