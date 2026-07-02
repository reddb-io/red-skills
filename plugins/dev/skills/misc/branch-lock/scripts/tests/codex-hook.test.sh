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
cat > "$primary/.red/config.yaml" <<'EOF'
plugins:
  dev:
    enabled: true
EOF
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
  <<<"$(payload "$primary" "git status")"
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

# Branch movement in the primary is now blocked unconditionally by the
# untouchable-primary rule (ADR 0083) — it fires before the branch-lock path, so
# switching away, and even switching *back* to the locked branch, is refused.
result="$(run_hook "$primary" "$(payload "$primary" "git switch feature")")"
rc="$(sed -n '1p' <<<"$result")"
stderr="$(sed -n '/---stderr---/,$p' <<<"$result")"
expect_eq "locked: switch away is blocked" "2" "$rc"
expect_contains "locked: error names ADR 0083" "ADR 0083" "$stderr"

result="$(run_hook "$primary" "$(payload "$primary" "git switch main")")"
rc="$(sed -n '1p' <<<"$result")"
stderr="$(sed -n '/---stderr---/,$p' <<<"$result")"
expect_eq "locked: switch back is also blocked (untouchable primary)" "2" "$rc"
expect_contains "locked: switch-back error names ADR 0083" "ADR 0083" "$stderr"

# Work-loss commands are caught by the unconditional untouchable-primary guard
# (#1024 reset/stash family + #1025 unconditional structure) even while a lock
# is active — the guard runs before the lock read, so the refusal names
# ADR 0083, not the branch lock.
result="$(run_hook "$primary" "$(payload "$primary" "git reset --hard HEAD~1")")"
rc="$(sed -n '1p' <<<"$result")"
stderr="$(sed -n '/---stderr---/,$p' <<<"$result")"
expect_eq "locked: work-loss reset --hard is blocked" "2" "$rc"
expect_contains "locked: work-loss error names untouchable primary" "ADR 0083" "$stderr"

rm -f "$primary/.red/tmp/branch-lock.yaml"
result="$(run_hook "$primary" "$(payload "$primary" "git switch feature")")"
rc="$(sed -n '1p' <<<"$result")"
stderr="$(sed -n '/---stderr---/,$p' <<<"$result")"
expect_eq "unlocked: switch is still blocked (untouchable primary)" "2" "$rc"
expect_contains "unlocked: error names ADR 0083" "ADR 0083" "$stderr"

# With no lock file the untouchable-primary guard still blocks every branch
# move, regardless of the legacy `dev.lock.primary-branch` toggle value.
mkdir -p "$primary/.red"
cat > "$primary/.red/config.yaml" <<'EOF'
plugins:
  dev:
    enabled: true
EOF

result="$(run_hook "$primary" "$(payload "$primary" "git switch feature")")"
rc="$(sed -n '1p' <<<"$result")"
stderr="$(sed -n '/---stderr---/,$p' <<<"$result")"
expect_eq "primary guard: switch blocked with no lock and no config" "2" "$rc"
expect_contains "primary guard: error names ADR 0083" "ADR 0083" "$stderr"

result="$(run_hook "$primary" "$(payload "$primary" "git checkout feature")")"
rc="$(sed -n '1p' <<<"$result")"
expect_eq "primary guard: checkout branch is blocked" "2" "$rc"

# issue #1024 — git reset (any form) and git stash (all subcommands) blocked,
# and the refusal explains the reason + the sanctioned worktree alternative.
result="$(run_hook "$primary" "$(payload "$primary" "git reset --hard")")"
rc="$(sed -n '1p' <<<"$result")"
stderr="$(sed -n '/---stderr---/,$p' <<<"$result")"
expect_eq "primary guard: reset --hard is blocked when flag is on" "2" "$rc"
expect_contains "primary guard: reset refusal points to worktree" ".red/tmp/work-" "$stderr"

result="$(run_hook "$primary" "$(payload "$primary" "git reset --soft HEAD~1")")"
rc="$(sed -n '1p' <<<"$result")"
expect_eq "primary guard: reset --soft is blocked when flag is on" "2" "$rc"

result="$(run_hook "$primary" "$(payload "$primary" "git stash")")"
rc="$(sed -n '1p' <<<"$result")"
expect_eq "primary guard: stash is blocked when flag is on" "2" "$rc"

result="$(run_hook "$primary" "$(payload "$primary" "git rebase --autostash main")")"
rc="$(sed -n '1p' <<<"$result")"
expect_eq "primary guard: rebase --autostash is blocked when flag is on" "2" "$rc"

result="$(run_hook "$primary" "$(payload "$primary" "git switch -b new")")"
rc="$(sed -n '1p' <<<"$result")"
expect_eq "primary guard: switch -b is blocked" "2" "$rc"

result="$(run_hook "$primary" "$(payload "$primary" "git commit -m wip")")"
rc="$(sed -n '1p' <<<"$result")"
expect_eq "primary guard: commit is allowed" "0" "$rc"

result="$(run_hook "$primary" "$(payload "$primary" "git worktree add ../wt feature")")"
rc="$(sed -n '1p' <<<"$result")"
expect_eq "primary guard: worktree add is allowed" "0" "$rc"

result="$(run_hook "$primary" "$(payload "$primary" "git status")")"
rc="$(sed -n '1p' <<<"$result")"
expect_eq "primary guard: read-only git is allowed" "0" "$rc"

# The legacy toggle is still readable but can no longer *enable* switching:
# explicitly false must not re-open primary branch movement (ADR 0083 §2).
cat > "$primary/.red/config.yaml" <<'EOF'
plugins:
  dev:
    enabled: true
    lock:
      primary-branch: false
EOF
result="$(run_hook "$primary" "$(payload "$primary" "git switch feature")")"
rc="$(sed -n '1p' <<<"$result")"
expect_eq "primary guard: legacy toggle off still blocks switch" "2" "$rc"

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
