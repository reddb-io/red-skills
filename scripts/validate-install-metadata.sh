#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

command -v jq >/dev/null || fail "jq is required"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

find plugins/dev/skills -name SKILL.md \
  -not -path '*/node_modules/*' \
  -not -path '*/deprecated/*' \
  -not -path '*/in-progress/*' \
  -print \
  | sed 's#/SKILL.md$##' \
  | sed 's#^plugins/dev/#./#' \
  | sort > "$tmp/published-skills"

jq -r '.skills[]' plugins/dev/.claude-plugin/plugin.json \
  | sort > "$tmp/claude-skills"

diff -u "$tmp/published-skills" "$tmp/claude-skills" \
  || fail "Claude plugin skill list is out of sync"

jq -e --slurp '.[0].version == .[1].version' \
  plugins/dev/.claude-plugin/plugin.json \
  plugins/dev/.codex-plugin/plugin.json >/dev/null \
  || fail "Claude and Codex plugin versions must match"

jq -e '.name == "dev"' plugins/dev/.codex-plugin/plugin.json >/dev/null \
  || fail "Codex plugin name must be dev"

jq -e '.skills == "./skills/"' plugins/dev/.codex-plugin/plugin.json >/dev/null \
  || fail "Codex plugin must expose ./skills/"

jq -e '.plugins[] | select(.name == "dev" and .source.path == "./plugins/dev")' \
  .agents/plugins/marketplace.json >/dev/null \
  || fail "Codex marketplace must expose ./plugins/dev"

echo "install metadata ok"
