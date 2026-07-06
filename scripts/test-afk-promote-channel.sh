#!/usr/bin/env bash
# Contract test for npm-backed canary channel promotion (ADR 0058/0091).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

failures=0

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  failures=$((failures + 1))
}

assert_contains() {
  local label="$1" needle="$2" file="$3"
  if ! grep -qF "$needle" "$file"; then
    fail "$label: expected '$needle' in $file"
  fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cat >"$tmp/npm" <<'FAKE_NPM'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$NPM_STUB_LOG"

if [ "${1:-}" = "--userconfig" ]; then
  [ -n "${2:-}" ] && [ -f "$2" ] || exit 12
  shift 2
fi

if [ "$1" = "view" ] &&
   [ "$2" = "@reddb-io/red-skills@1.280.0" ] &&
   [ "$3" = "version" ]; then
  printf '1.280.0\n'
  exit 0
fi

if [ "$1" = "dist-tag" ] &&
   [ "$2" = "add" ] &&
   [ "$3" = "@reddb-io/red-skills@1.280.0" ] &&
   [ "$4" = "canary" ]; then
  [ -n "${NODE_AUTH_TOKEN:-}" ] || exit 13
  printf '+canary: @reddb-io/red-skills@1.280.0\n'
  exit 0
fi

if [ "$1" = "dist-tag" ] &&
   [ "$2" = "ls" ] &&
   [ "$3" = "@reddb-io/red-skills" ]; then
  printf 'latest: 1.280.0\ncanary: 1.279.0\n'
  exit 0
fi

exit 42
FAKE_NPM
chmod +x "$tmp/npm"

log="$tmp/npm.log"
NPM_STUB_LOG="$log" PATH="$tmp:$PATH" NODE_AUTH_TOKEN=token \
  scripts/afk-promote-channel.sh --force cut v1.280.0 >"$tmp/cut.out"

assert_contains "published version is checked before mutation" \
  "view @reddb-io/red-skills@1.280.0 version" "$log"
assert_contains "canary dist-tag is moved to the chosen published version" \
  "dist-tag add @reddb-io/red-skills@1.280.0 canary" "$log"
assert_contains "operator output names the npm dist-tag move" \
  "moved npm dist-tag canary -> @reddb-io/red-skills@1.280.0" "$tmp/cut.out"

missing_token_err="$tmp/missing-token.err"
if NPM_STUB_LOG="$tmp/no-token.log" PATH="$tmp:$PATH" \
   env -u NODE_AUTH_TOKEN -u NPM_TOKEN \
   scripts/afk-promote-channel.sh --force cut 1.280.0 >"$tmp/no-token.out" 2>"$missing_token_err"; then
  fail "cut without npm token should fail"
fi
assert_contains "missing token failure is loud" \
  "NODE_AUTH_TOKEN or NPM_TOKEN is required" "$missing_token_err"

if grep -qE '\bgit (tag|push|rev-parse)\b' scripts/afk-promote-channel.sh; then
  fail "promote script still contains stale GitHub floating-tag mutation"
fi

if (( failures > 0 )); then
  exit 1
fi

printf 'afk promote channel contract ok\n'
