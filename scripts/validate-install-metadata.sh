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

  local claude_mcp_path codex_mcp_path
  claude_mcp_path="$(jq -r '.mcpServers // empty' "$dir/.claude-plugin/plugin.json")"
  codex_mcp_path="$(jq -r '.mcpServers // empty' "$dir/.codex-plugin/plugin.json")"
  if [[ -n "$claude_mcp_path" ]]; then
    [[ -n "$codex_mcp_path" ]] \
      || fail "$plugin: Codex plugin must expose mcpServers when Claude does"
    [[ "$claude_mcp_path" == ./* && "$codex_mcp_path" == ./* ]] \
      || fail "$plugin: MCP manifest paths must be relative"
    [[ -f "$dir/${claude_mcp_path#./}" ]] \
      || fail "$plugin: Claude MCP manifest not found: $claude_mcp_path"
    [[ -f "$dir/${codex_mcp_path#./}" ]] \
      || fail "$plugin: Codex MCP manifest not found: $codex_mcp_path"
    jq -e '.mcpServers | type == "object"' "$dir/${claude_mcp_path#./}" >/dev/null \
      || fail "$plugin: Claude MCP manifest must contain an mcpServers object"
    jq -e '.mcpServers | type == "object"' "$dir/${codex_mcp_path#./}" >/dev/null \
      || fail "$plugin: Codex MCP manifest must contain an mcpServers object"
  fi

  local hooks_path
  hooks_path="$(jq -r '.hooks // empty' "$dir/.codex-plugin/plugin.json")"
  if [[ -n "$hooks_path" ]]; then
    [[ "$hooks_path" == ./* ]] \
      || fail "$plugin: Codex hooks path must be relative"
    [[ -f "$dir/${hooks_path#./}" ]] \
      || fail "$plugin: Codex hooks manifest not found: $hooks_path"
    jq -e '.hooks | type == "object"' "$dir/${hooks_path#./}" >/dev/null \
      || fail "$plugin: Codex hooks manifest must contain a hooks object"
  fi

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
