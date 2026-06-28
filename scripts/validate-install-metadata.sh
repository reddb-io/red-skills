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

bash -n scripts/install.sh || fail "scripts/install.sh has invalid bash syntax"
bash -n scripts/install-opencode.sh || fail "scripts/install-opencode.sh has invalid bash syntax"

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

  # Codex `skills` is either the legacy whole-tree string ("./skills/") or, since
  # #610, an array of published bucket paths (excluding in-progress/). Accept both;
  # every array entry must be a ./skills/<bucket>/ path that exists on disk.
  jq -e '
    (.skills == "./skills/")
    or ((.skills | type) == "array"
        and (.skills | length) > 0
        and ([.skills[] | type == "string" and startswith("./skills/") and endswith("/")] | all))
  ' "$dir/.codex-plugin/plugin.json" >/dev/null \
    || fail "$plugin: Codex plugin must expose ./skills/ or an array of ./skills/<bucket>/ paths"
  if jq -e '(.skills | type) == "array"' "$dir/.codex-plugin/plugin.json" >/dev/null; then
    local bucket
    while IFS= read -r bucket; do
      [[ -d "$dir/${bucket#./}" ]] \
        || fail "$plugin: Codex skills bucket not found on disk: $bucket"
    done < <(jq -r '.skills[]' "$dir/.codex-plugin/plugin.json")
  fi

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
    if [[ "$plugin" == "dev" ]]; then
      [[ -x "$dir/hooks/code-nav-mcp.sh" ]] \
        || fail "$plugin: code-nav MCP launcher must exist and be executable"
      jq -e '.mcpServers["code-nav"].args[]? | contains("code-nav-mcp.sh")' "$dir/${codex_mcp_path#./}" >/dev/null \
        || fail "$plugin: code-nav MCP manifest must use the on-demand launcher"
    fi
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

validate_dev_fetch_hooks() {
  local root="$tmp/dev-plugin-root"
  mkdir -p "$root/.claude-plugin" "$root/.codex-plugin" "$root/hooks"

  printf '{"version":"9.9.9"}\n' > "$root/.claude-plugin/plugin.json"
  printf '{"version":"9.9.9"}\n' > "$root/.codex-plugin/plugin.json"
  cat > "$root/hooks/red-fetch.mjs" <<'EOF'
#!/usr/bin/env node
console.log(`red-fetch stdout ${process.argv.slice(2).join(" ")}`);
console.error("red-fetch stderr");
EOF
  chmod +x "$root/hooks/red-fetch.mjs"

  local payload='{"hook_event_name":"SessionStart"}'
  local cmd out

  cmd="$(jq -r '.hooks.SessionStart[0].hooks[0].command // empty' plugins/dev/hooks/claude.hooks.json)"
  [[ -n "$cmd" ]] || fail "dev: Claude hooks must run red-fetch on SessionStart"
  out="$(CLAUDE_PLUGIN_ROOT="$root" bash -lc "$cmd" <<<"$payload")"
  [[ "$out" == "{}" ]] \
    || fail "dev: Claude SessionStart hook must print exactly {} after red-fetch"

  cmd="$(jq -r '.hooks.SessionStart[0].hooks[0].command // empty' plugins/dev/hooks/codex.hooks.json)"
  [[ -n "$cmd" ]] || fail "dev: Codex hooks must run red-fetch on SessionStart"
  out="$(CODEX_PLUGIN_ROOT="$root" bash -lc "$cmd" <<<"$payload")"
  [[ "$out" == "{}" ]] \
    || fail "dev: Codex SessionStart hook must print exactly {} after red-fetch"
}

validate_dev_fetch_hooks

# Packaged Claude Code agents (plugins/<plugin>/agents/) — only Claude loads
# them, so we validate frontmatter and ensure the Codex side does not
# advertise them. The script no-ops when no plugin ships an agents/ dir.
"$REPO/scripts/validate-agent-metadata.sh"

# memory hard-depends on dev, in both plugin manifests and both marketplaces.
for f in \
  plugins/memory/.claude-plugin/plugin.json \
  plugins/memory/.codex-plugin/plugin.json; do
  jq -e '.dependencies | index("dev")' "$f" >/dev/null \
    || fail "memory: $f must declare a dependency on dev"
done

echo "install metadata ok"
