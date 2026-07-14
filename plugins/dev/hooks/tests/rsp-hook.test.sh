#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_HOOK="$(cd "$HERE/.." && pwd)/rsp-hook.sh"

pass=0
fail=0

ok() {
  echo "PASS  $1"
  pass=$((pass + 1))
}

bad() {
  echo "FAIL  $1"
  fail=$((fail + 1))
}

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

tmp="$(mktemp -d -t rsp-hook.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT

plugin="$tmp/plugins/dev"
cache="$tmp/cache"
hook_cache="$tmp/hook-cache"
mkdir -p "$plugin/hooks" "$plugin/.codex-plugin" "$cache"
cp "$PLUGIN_HOOK" "$plugin/hooks/rsp-hook.sh"
chmod 0755 "$plugin/hooks/rsp-hook.sh"
printf '{"version":"9.9.9"}\n' >"$plugin/.codex-plugin/plugin.json"

write_bundle() {
  local path="$1"
  mkdir -p "$(dirname "$path")"
  cat >"$path" <<'JS'
import { appendFileSync } from "node:fs";
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  appendFileSync(process.env.RSP_HOOK_LOG, JSON.stringify({ args: process.argv.slice(2), input: JSON.parse(input) }) + "\n");
  process.stdout.write("{}");
});
JS
}

payload='{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"echo ok"}}'
bundle="$cache/rsp-9.9.9.bundle.min.mjs"
log="$tmp/rsp-hook.log"
write_bundle "$bundle"

out="$tmp/out"
err="$tmp/err"

CODEX_PLUGIN_ROOT="$plugin" RED_SKILLS_CACHE_DIR="$cache" RED_SKILLS_RSP_HOOK_CACHE_DIR="$hook_cache" \
  "$plugin/hooks/rsp-hook.sh" prime >"$out" 2>"$err"
expect_eq "prime: prints empty JSON" "{}" "$(<"$out")"

CODEX_PLUGIN_ROOT="$plugin" RED_SKILLS_CACHE_DIR="$cache" RED_SKILLS_RSP_HOOK_CACHE_DIR="$hook_cache" RSP_HOOK_LOG="$log" \
  "$plugin/hooks/rsp-hook.sh" codex-pre-exec <<<"$payload" >"$out" 2>"$err"
expect_eq "hot path: exits 0" "0" "$?"
expect_contains "hot path: invokes cached bundle" "codex-pre-exec" "$(<"$log")"

rm -rf "$hook_cache" "$log"
CODEX_PLUGIN_ROOT="$plugin" RED_SKILLS_CACHE_DIR="$cache" RED_SKILLS_RSP_HOOK_CACHE_DIR="$hook_cache" RSP_HOOK_LOG="$log" \
  "$plugin/hooks/rsp-hook.sh" codex-pre-exec <<<"$payload" >"$out" 2>"$err"
expect_eq "missing cache: fail-open rc" "0" "$?"
if [[ ! -e "$log" ]]; then ok "missing cache: no hot-path discovery"; else bad "missing cache: no hot-path discovery"; fi

CODEX_PLUGIN_ROOT="$plugin" RED_SKILLS_CACHE_DIR="$cache" RED_SKILLS_RSP_HOOK_CACHE_DIR="$hook_cache" \
  "$plugin/hooks/rsp-hook.sh" prime >"$out" 2>"$err"
future_epoch=$(( $(date +%s) + 5 ))
touch -d "@$future_epoch" "$plugin/.codex-plugin/plugin.json" 2>/dev/null || touch "$plugin/.codex-plugin/plugin.json"
CODEX_PLUGIN_ROOT="$plugin" RED_SKILLS_CACHE_DIR="$cache" RED_SKILLS_RSP_HOOK_CACHE_DIR="$hook_cache" RSP_HOOK_LOG="$log" RED_SKILLS_HOOK_DEBUG=1 \
  "$plugin/hooks/rsp-hook.sh" codex-pre-exec <<<"$payload" >"$out" 2>"$err"
expect_eq "stale manifest: fail-open rc" "0" "$?"
expect_contains "stale manifest: reason surfaces under debug" "stale rsp cache" "$(<"$err")"

printf 'process.exit(42);\n' >"$bundle"
CODEX_PLUGIN_ROOT="$plugin" RED_SKILLS_CACHE_DIR="$cache" RED_SKILLS_RSP_HOOK_CACHE_DIR="$hook_cache" \
  "$plugin/hooks/rsp-hook.sh" prime >"$out" 2>"$err"
CODEX_PLUGIN_ROOT="$plugin" RED_SKILLS_CACHE_DIR="$cache" RED_SKILLS_RSP_HOOK_CACHE_DIR="$hook_cache" RED_SKILLS_HOOK_DEBUG=1 \
  "$plugin/hooks/rsp-hook.sh" codex-pre-exec <<<"$payload" >"$out" 2>"$err"
expect_eq "bundle failure: fail-open rc" "0" "$?"
expect_contains "bundle failure: reason surfaces under debug" "exited 42" "$(<"$err")"

CODEX_PLUGIN_ROOT="$plugin" RED_SKILLS_CACHE_DIR="$tmp/missing-cache" RED_SKILLS_RSP_HOOK_CACHE_DIR="$tmp/missing-hook-cache" \
  "$plugin/hooks/rsp-hook.sh" prime >"$out" 2>"$err"
expect_eq "missing bundle: prime fail-open JSON" "{}" "$(<"$out")"

echo
echo "summary: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
