#!/usr/bin/env bash
# Unit test for the dev PreToolUse command guard.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/.." && pwd)"
HOOK="$PLUGIN_ROOT/command-guard.sh"
CLAUDE_MANIFEST="$PLUGIN_ROOT/claude.hooks.json"
CODEX_MANIFEST="$PLUGIN_ROOT/codex.hooks.json"

pass=0
fail=0

ok() { echo "PASS  $1"; pass=$((pass + 1)); }
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

tmp="$(mktemp -d -t command-guard.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT

repo="$tmp/repo"
mkdir -p "$repo/.red"

payload() {
  local root="$1" cmd="$2"
  jq -nc --arg cwd "$root" --arg cmd "$cmd" \
    '{hook_event_name:"PreToolUse", cwd:$cwd, tool_name:"Bash", tool_input:{command:$cmd}}'
}

opencode_payload() {
  local root="$1" cmd="$2"
  jq -nc --arg cwd "$root" --arg cmd "$cmd" \
    '{hook_event_name:"PreToolUse", cwd:$cwd, tool_name:"bash", tool_input:{args:{command:$cmd}}}'
}

run_hook() {
  local root="$1" json="$2" out err rc
  out="$tmp/out"
  err="$tmp/err"
  CLAUDE_PROJECT_DIR="$root" CODEX_PROJECT_DIR="$root" "$HOOK" >"$out" 2>"$err" <<<"$json"
  rc=$?
  printf '%s\n---stdout---\n%s\n---stderr---\n%s\n' "$rc" "$(<"$out")" "$(<"$err")"
}

manifest_hook="$(jq -r '.hooks.PreToolUse[0].hooks[] | select(.command | contains("command-guard.sh")) | .command' "$CLAUDE_MANIFEST")"
expect_contains "claude manifest: wires command-guard.sh" "command-guard.sh" "$manifest_hook"
expect_contains "claude manifest: wrapper drains stdin" 'cat >"$tmp"' "$manifest_hook"

manifest_hook="$(jq -r '.hooks.PreToolUse[0].hooks[] | select(.command | contains("command-guard.sh")) | .command' "$CODEX_MANIFEST")"
expect_contains "codex manifest: wires command-guard.sh" "command-guard.sh" "$manifest_hook"
expect_contains "codex manifest: wrapper drains stdin" 'cat >"$tmp"' "$manifest_hook"

missing_root="$tmp/missing-plugin-root"
mkdir -p "$missing_root"
out="$tmp/manifest-out"
err="$tmp/manifest-err"
CLAUDE_PLUGIN_ROOT="$missing_root" CLAUDE_PROJECT_DIR="$repo" bash -lc "$(jq -r '.hooks.PreToolUse[0].hooks[] | select(.command | contains("command-guard.sh")) | .command' "$CLAUDE_MANIFEST")" \
  >"$out" 2>"$err" <<<"$(payload "$repo" "sudo make install")"
rc=$?
expect_eq "manifest: missing hook fails open" "0" "$rc"
expect_eq "manifest: missing hook prints empty JSON" "{}" "$(<"$out")"

rm -f "$repo/.red/config.yaml"
result="$(run_hook "$repo" "$(payload "$repo" "sudo make install")")"
expect_eq "missing config: allow" "0" "$(sed -n '1p' <<<"$result")"
expect_eq "missing config: prints empty JSON" "{}" "$(sed -n '/---stdout---/,/---stderr---/p' <<<"$result" | sed '1d;$d')"

cat >"$repo/.red/config.yaml" <<'YAML'
plugins:
  dev:
    enabled: false
    command_guard:
      deny:
        - sudo
YAML
result="$(run_hook "$repo" "$(payload "$repo" "sudo make install")")"
expect_eq "plugin disabled: allow" "0" "$(sed -n '1p' <<<"$result")"

cat >"$repo/.red/config.yaml" <<'YAML'
plugins:
  dev:
    enabled: true
YAML
result="$(run_hook "$repo" "$(payload "$repo" "sudo make install")")"
expect_eq "empty deny list: allow" "0" "$(sed -n '1p' <<<"$result")"

cat >"$repo/.red/config.yaml" <<'YAML'
plugins:
  dev:
    enabled: true
    command_guard:
      deny:
        - sudo
        - "rm -rf *" # destructive glob
YAML
result="$(run_hook "$repo" "$(payload "$repo" "sudo make install")")"
rc="$(sed -n '1p' <<<"$result")"
stderr="$(sed -n '/---stderr---/,$p' <<<"$result")"
expect_eq "prefix rule: blocks sudo command family" "2" "$rc"
expect_contains "prefix rule: names deny rule" "matched deny rule 'sudo'" "$stderr"

result="$(run_hook "$repo" "$(payload "$repo" "rm -rf build")")"
rc="$(sed -n '1p' <<<"$result")"
stderr="$(sed -n '/---stderr---/,$p' <<<"$result")"
expect_eq "glob rule: blocks full command" "2" "$rc"
expect_contains "glob rule: names glob" "rm -rf *" "$stderr"

result="$(run_hook "$repo" "$(payload "$repo" "printf safe")")"
expect_eq "nonmatching command: allow" "0" "$(sed -n '1p' <<<"$result")"

result="$(run_hook "$repo" "$(opencode_payload "$repo" "sudo true")")"
expect_eq "opencode-shaped args.command payload: block" "2" "$(sed -n '1p' <<<"$result")"

cat >"$repo/.red/config.yaml" <<'YAML'
plugins:
  dev:
    enabled: true
dev:
  command_guard:
    deny: "git reset --hard"
YAML
result="$(run_hook "$repo" "$(payload "$repo" "git reset --hard HEAD")")"
expect_eq "top-level dev fallback scalar: block" "2" "$(sed -n '1p' <<<"$result")"

echo
echo "summary: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
