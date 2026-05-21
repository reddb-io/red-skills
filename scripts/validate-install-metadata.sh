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

# Validate one plugin's install metadata: Claude skill list matches the SKILL.md
# tree on disk, Claude/Codex versions agree, and the Codex plugin exposes the
# whole skills/ tree under the right name.
validate_plugin() {
  local plugin="$1"
  local dir="plugins/$plugin"

  find "$dir/skills" -name SKILL.md \
    -not -path '*/node_modules/*' \
    -not -path '*/deprecated/*' \
    -not -path '*/in-progress/*' \
    -print \
    | sed 's#/SKILL.md$##' \
    | sed "s#^$dir/#./#" \
    | sort > "$tmp/published-skills"

  jq -r '.skills[]' "$dir/.claude-plugin/plugin.json" \
    | sort > "$tmp/claude-skills"

  diff -u "$tmp/published-skills" "$tmp/claude-skills" \
    || fail "$plugin: Claude plugin skill list is out of sync"

  jq -e --slurp '.[0].version == .[1].version' \
    "$dir/.claude-plugin/plugin.json" \
    "$dir/.codex-plugin/plugin.json" >/dev/null \
    || fail "$plugin: Claude and Codex plugin versions must match"

  jq -e --arg n "$plugin" '.name == $n' "$dir/.codex-plugin/plugin.json" >/dev/null \
    || fail "$plugin: Codex plugin name must be $plugin"

  jq -e '.skills == "./skills/"' "$dir/.codex-plugin/plugin.json" >/dev/null \
    || fail "$plugin: Codex plugin must expose ./skills/"

  jq -e --arg p "./$dir" '.plugins[] | select(.source.path == $p)' \
    .agents/plugins/marketplace.json >/dev/null \
    || fail "$plugin: Codex marketplace must expose ./$dir"

  jq -e --arg p "./$dir" '.plugins[] | select(.source == $p)' \
    .claude-plugin/marketplace.json >/dev/null \
    || fail "$plugin: Claude marketplace must expose ./$dir"
}

validate_plugin dev
validate_plugin memory

# memory hard-depends on dev, in both plugin manifests and both marketplaces.
for f in \
  plugins/memory/.claude-plugin/plugin.json \
  plugins/memory/.codex-plugin/plugin.json; do
  jq -e '.dependencies | index("dev")' "$f" >/dev/null \
    || fail "memory: $f must declare a dependency on dev"
done

echo "install metadata ok"
