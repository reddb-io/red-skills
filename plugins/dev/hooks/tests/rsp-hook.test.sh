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
printf '{"version":"9.9.9"}\n' >"$plugin/.codex-plugin/plugin.json"
CODEX_PLUGIN_ROOT="$plugin" RED_SKILLS_CACHE_DIR="$cache" RED_SKILLS_RSP_HOOK_CACHE_DIR="$hook_cache" \
  "$plugin/hooks/rsp-hook.sh" prime >"$out" 2>"$err"
CODEX_PLUGIN_ROOT="$plugin" RED_SKILLS_CACHE_DIR="$cache" RED_SKILLS_RSP_HOOK_CACHE_DIR="$hook_cache" RED_SKILLS_HOOK_DEBUG=1 \
  "$plugin/hooks/rsp-hook.sh" codex-pre-exec <<<"$payload" >"$out" 2>"$err"
expect_eq "bundle failure: fail-open rc" "0" "$?"
expect_contains "bundle failure: reason surfaces under debug" "exited 42" "$(<"$err")"

CODEX_PLUGIN_ROOT="$plugin" RED_SKILLS_CACHE_DIR="$tmp/missing-cache" RED_SKILLS_RSP_HOOK_CACHE_DIR="$tmp/missing-hook-cache" \
  "$plugin/hooks/rsp-hook.sh" prime >"$out" 2>"$err"
expect_eq "missing bundle: prime fail-open JSON" "{}" "$(<"$out")"

# --- stdin-drain regression -------------------------------------------------
# The host writes the payload AFTER spawning the hook. A fail-open path that
# returns without reading stdin leaves the pipe without a reader, so the host's
# write dies with EPIPE. Every exit path must drain stdin first.
epipe_seq=0
expect_no_epipe() {
  local label="$1" mode="$2"; shift 2
  local fifo werr rc pid
  epipe_seq=$((epipe_seq + 1))
  fifo="$tmp/epipe-fifo.$epipe_seq"
  werr="$tmp/epipe-werr.$epipe_seq"
  mkfifo "$fifo"

  ( env "$@" "$plugin/hooks/rsp-hook.sh" "$mode" <"$fifo" >/dev/null 2>&1 ) &
  pid=$!
  exec 9>"$fifo"
  # Let the hook reach (and take) its fail-open exit before we write.
  sleep 0.5
  rc=0
  ( printf '%s' "$payload" >&9 ) 2>"$werr" || rc=$?
  exec 9>&-
  wait "$pid" 2>/dev/null || true
  rm -f "$fifo"

  if [[ "$rc" -eq 0 ]]; then
    ok "$label"
  else
    bad "$label"
    printf '  write failed rc=%s: %s\n' "$rc" "$(<"$werr")"
  fi
}

# Restore a healthy bundle + fresh cache so each case isolates one fail-open path.
write_bundle "$bundle"
printf '{"version":"9.9.9"}\n' >"$plugin/.codex-plugin/plugin.json"
rm -rf "$hook_cache"
CODEX_PLUGIN_ROOT="$plugin" RED_SKILLS_CACHE_DIR="$cache" RED_SKILLS_RSP_HOOK_CACHE_DIR="$hook_cache" \
  "$plugin/hooks/rsp-hook.sh" prime >"$out" 2>"$err" </dev/null

# run_hook: plugin root unset
expect_no_epipe "drain: run_hook plugin root unset" codex-pre-exec \
  RED_SKILLS_CACHE_DIR="$cache" RED_SKILLS_RSP_HOOK_CACHE_DIR="$hook_cache"

# run_hook: cache missing
expect_no_epipe "drain: run_hook cache missing" codex-pre-exec \
  CODEX_PLUGIN_ROOT="$plugin" RED_SKILLS_CACHE_DIR="$cache" \
  RED_SKILLS_RSP_HOOK_CACHE_DIR="$tmp/absent-hook-cache"

# run_hook: cache root mismatch. Without RED_SKILLS_RSP_HOOK_CACHE_DIR the cache
# lives inside the plugin root, so a cache recording a different PLUGIN_ROOT is
# found but rejected.
mkdir -p "$tmp/other-root"
{
  printf 'PLUGIN_ROOT=%s\n' "$plugin"
  printf 'PLUGIN_MANIFEST=\n'
  printf 'RSP_BUNDLE=%s\n' "$bundle"
  printf 'REDDB_BIN=\n'
} >"$tmp/other-root/.red-skills-rsp-hook.cache"
expect_no_epipe "drain: run_hook cache root mismatch" codex-pre-exec \
  CODEX_PLUGIN_ROOT="$tmp/other-root" RED_SKILLS_CACHE_DIR="$cache"

# run_hook: stale cache (manifest newer than the cache file)
touch -d "@$(( $(date +%s) + 5 ))" "$plugin/.codex-plugin/plugin.json" 2>/dev/null \
  || touch "$plugin/.codex-plugin/plugin.json"
expect_no_epipe "drain: run_hook stale cache" codex-pre-exec \
  CODEX_PLUGIN_ROOT="$plugin" RED_SKILLS_CACHE_DIR="$cache" \
  RED_SKILLS_RSP_HOOK_CACHE_DIR="$hook_cache"
printf '{"version":"9.9.9"}\n' >"$plugin/.codex-plugin/plugin.json"

# run_hook: cached bundle missing
rm -rf "$hook_cache"
CODEX_PLUGIN_ROOT="$plugin" RED_SKILLS_CACHE_DIR="$cache" RED_SKILLS_RSP_HOOK_CACHE_DIR="$hook_cache" \
  "$plugin/hooks/rsp-hook.sh" prime >"$out" 2>"$err" </dev/null
mv "$bundle" "$bundle.parked"
expect_no_epipe "drain: run_hook cached bundle missing" codex-pre-exec \
  CODEX_PLUGIN_ROOT="$plugin" RED_SKILLS_CACHE_DIR="$cache" \
  RED_SKILLS_RSP_HOOK_CACHE_DIR="$hook_cache"
mv "$bundle.parked" "$bundle"

# run_hook: happy path still drains (bundle consumes the payload)
rm -rf "$hook_cache" "$log"
CODEX_PLUGIN_ROOT="$plugin" RED_SKILLS_CACHE_DIR="$cache" RED_SKILLS_RSP_HOOK_CACHE_DIR="$hook_cache" \
  "$plugin/hooks/rsp-hook.sh" prime >"$out" 2>"$err" </dev/null
expect_no_epipe "drain: run_hook hot path" codex-pre-exec \
  CODEX_PLUGIN_ROOT="$plugin" RED_SKILLS_CACHE_DIR="$cache" \
  RED_SKILLS_RSP_HOOK_CACHE_DIR="$hook_cache" RSP_HOOK_LOG="$log"
expect_contains "drain: hot path still forwards the payload" "echo ok" "$(<"$log")"

# prime_cache: plugin root unset
expect_no_epipe "drain: prime plugin root unset" prime \
  RED_SKILLS_CACHE_DIR="$cache" RED_SKILLS_RSP_HOOK_CACHE_DIR="$hook_cache"

# prime_cache: bundle not found
expect_no_epipe "drain: prime bundle missing" prime \
  CODEX_PLUGIN_ROOT="$plugin" RED_SKILLS_CACHE_DIR="$tmp/absent-bundle-cache" \
  RED_SKILLS_RSP_HOOK_CACHE_DIR="$tmp/absent-hook-cache-2"

# prime_cache: cache directory not writable
if [[ "$(id -u)" -ne 0 ]]; then
  unwritable="$tmp/unwritable"
  mkdir -p "$unwritable"
  chmod 0500 "$unwritable"
  expect_no_epipe "drain: prime cache dir unwritable" prime \
    CODEX_PLUGIN_ROOT="$plugin" RED_SKILLS_CACHE_DIR="$cache" \
    RED_SKILLS_RSP_HOOK_CACHE_DIR="$unwritable/nested"
  expect_no_epipe "drain: prime cache write fails" prime \
    CODEX_PLUGIN_ROOT="$plugin" RED_SKILLS_CACHE_DIR="$cache" \
    RED_SKILLS_RSP_HOOK_CACHE_DIR="$unwritable"
  chmod 0700 "$unwritable"
fi

# unknown mode
expect_no_epipe "drain: unknown hook mode" not-a-real-mode \
  CODEX_PLUGIN_ROOT="$plugin" RED_SKILLS_CACHE_DIR="$cache" \
  RED_SKILLS_RSP_HOOK_CACHE_DIR="$hook_cache"

echo
echo "summary: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
