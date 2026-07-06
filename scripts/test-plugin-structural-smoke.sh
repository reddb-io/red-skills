#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

out="$(mktemp)"
trap 'rm -f "$out"' EXIT

if node scripts/plugin-structural-smoke.mjs \
  scripts/fixtures/plugin-structural-smoke/broken/plugins/broken \
  scripts/fixtures/plugin-structural-smoke/broken >"$out" 2>&1; then
  cat "$out" >&2
  fail "broken plugin fixture unexpectedly passed structural smoke"
fi

grep -Eq 'root README|wildcard tool grant' "$out" \
  || fail "broken fixture failure did not report a structural smoke invariant"

echo "plugin structural smoke fixture ok"
