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
bash scripts/test-install-redcode-host.sh \
  || fail "RedCode host install regression test failed"
bash -n scripts/install-pi.sh || fail "scripts/install-pi.sh has invalid bash syntax"
node scripts/generate-pi-manifests.mjs --root "$REPO" --check \
  || fail "plugins/<name>/package.json Pi manifests are stale; run pnpm pi:manifests"
node scripts/build-pi-packages.mjs --root "$REPO" --check \
  || fail "packaging/pi/<name>/ staged Pi packages are stale; run pnpm pi:packages:build"

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

  jq -e --slurp '.[0].version == .[1].version and .[1].version == .[2].version' \
    "$dir/.claude-plugin/plugin.json" \
    "$dir/.codex-plugin/plugin.json" \
    "$dir/.gemini-plugin/plugin.json" >/dev/null \
    || fail "$plugin: Claude, Codex and Gemini plugin versions must match"

  jq -e --arg n "$plugin" '.name == $n' "$dir/.codex-plugin/plugin.json" >/dev/null \
    || fail "$plugin: Codex plugin name must be $plugin"

  jq -e --arg n "$plugin" '.name == $n' "$dir/.gemini-plugin/plugin.json" >/dev/null \
    || fail "$plugin: Gemini plugin name must be $plugin"

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

  local claude_mcp_path codex_mcp_path gemini_mcp_path
  claude_mcp_path="$(jq -r '.mcpServers // empty' "$dir/.claude-plugin/plugin.json")"
  codex_mcp_path="$(jq -r '.mcpServers // empty' "$dir/.codex-plugin/plugin.json")"
  gemini_mcp_path="$(jq -r '.mcpServers // empty' "$dir/.gemini-plugin/plugin.json")"
  if [[ -n "$claude_mcp_path" ]]; then
    [[ -n "$codex_mcp_path" ]] \
      || fail "$plugin: Codex plugin must expose mcpServers when Claude does"
    [[ -n "$gemini_mcp_path" ]] \
      || fail "$plugin: Gemini plugin must expose mcpServers when Claude does"
    [[ "$claude_mcp_path" == ./* && "$codex_mcp_path" == ./* && "$gemini_mcp_path" == ./* ]] \
      || fail "$plugin: MCP manifest paths must be relative"
    [[ -f "$dir/${claude_mcp_path#./}" ]] \
      || fail "$plugin: Claude MCP manifest not found: $claude_mcp_path"
    [[ -f "$dir/${codex_mcp_path#./}" ]] \
      || fail "$plugin: Codex MCP manifest not found: $codex_mcp_path"
    [[ -f "$dir/${gemini_mcp_path#./}" ]] \
      || fail "$plugin: Gemini MCP manifest not found: $gemini_mcp_path"
    jq -e '.mcpServers | type == "object"' "$dir/${claude_mcp_path#./}" >/dev/null \
      || fail "$plugin: Claude MCP manifest must contain an mcpServers object"
    jq -e '.mcpServers | type == "object"' "$dir/${codex_mcp_path#./}" >/dev/null \
      || fail "$plugin: Codex MCP manifest must contain an mcpServers object"
    jq -e '.mcpServers | type == "object"' "$dir/${gemini_mcp_path#./}" >/dev/null \
      || fail "$plugin: Gemini MCP manifest must contain an mcpServers object"
    if [[ "$plugin" == "dev" ]]; then
      [[ -x "$dir/hooks/code-nav-mcp.sh" ]] \
        || fail "$plugin: navigator MCP launcher must exist and be executable"
      jq -e '.mcpServers["navigator"].args[]? | contains("code-nav-mcp.sh")' "$dir/${codex_mcp_path#./}" >/dev/null \
        || fail "$plugin: navigator MCP manifest must use the on-demand launcher"
      [[ -x "$dir/hooks/redskilled-mcp.sh" ]] \
        || fail "$plugin: redskilled MCP launcher must exist and be executable"
      jq -e '.mcpServers["redskilled"].args[]? | contains("redskilled-mcp.sh")' "$dir/${codex_mcp_path#./}" >/dev/null \
        || fail "$plugin: redskilled MCP manifest must use the on-demand launcher"
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

  jq -e --arg p "./$dir" '.plugins[] | select(.source.path == $p)' \
    .gemini-plugin/marketplace.json >/dev/null \
    || fail "$plugin: Gemini marketplace must expose ./$dir"

  jq -e --arg p "./$dir" '.plugins[] | select(.source == $p)' \
    .claude-plugin/marketplace.json >/dev/null \
    || fail "$plugin: Claude marketplace must expose ./$dir"

  # Pi package manifest: must exist, declare the pi-package keyword, carry the
  # same version as the Claude/Codex manifests, and enumerate only buckets
  # that exist on disk under ./skills/.
  local pi_pkg="$dir/package.json"
  [ -f "$pi_pkg" ] \
    || fail "$plugin: Pi package.json missing: $pi_pkg"
  jq -e '.keywords | index("pi-package")' "$pi_pkg" >/dev/null \
    || fail "$plugin: $pi_pkg must declare the pi-package keyword"
  jq -e --arg plugin "$plugin" \
    '(.name | startswith("@reddb-io/red-skills-" + $plugin))' "$pi_pkg" >/dev/null \
    || fail "$plugin: $pi_pkg name must be @reddb-io/red-skills-$plugin"
  jq -e --slurp '.[0].version == .[1].version' \
    "$dir/.claude-plugin/plugin.json" "$pi_pkg" >/dev/null \
    || fail "$plugin: $pi_pkg version must match Claude/Codex manifests"
  jq -e '.pi.skills | type == "array" and length > 0' "$pi_pkg" >/dev/null \
    || fail "$plugin: $pi_pkg pi.skills must be a non-empty array"
  local bucket
  while IFS= read -r bucket; do
    [[ "$bucket" == ./skills/* ]] \
      || fail "$plugin: Pi skill bucket must start with ./skills/: $bucket"
    [[ -d "$dir/${bucket#./}" ]] \
      || fail "$plugin: Pi skill bucket not found on disk: $bucket"
  done < <(jq -r '.pi.skills[]' "$pi_pkg")

  # Staged npm package (ADR 0110): packaging/pi/<name>/package.json must mirror
  # the local-path manifest with the publishConfig + files fields added.
  local npm_pkg="packaging/pi/$plugin/package.json"
  [ -f "$npm_pkg" ] \
    || fail "$plugin: staged Pi npm package missing: $npm_pkg"
  jq -e --slurp '.[0].version == .[1].version' \
    "$dir/.claude-plugin/plugin.json" "$npm_pkg" >/dev/null \
    || fail "$plugin: $npm_pkg version must match Claude/Codex manifests"
  jq -e '.publishConfig.access == "public"' "$npm_pkg" >/dev/null \
    || fail "$plugin: $npm_pkg publishConfig.access must be public"
  jq -e --arg plugin "$plugin" \
    '.name == "@reddb-io/red-skills-" + $plugin' "$npm_pkg" >/dev/null \
    || fail "$plugin: $npm_pkg name must be @reddb-io/red-skills-$plugin"
  jq -e '.files | index("skills/**/*") and index("package.json") and index("README.md")' \
    "$npm_pkg" >/dev/null \
    || fail "$plugin: $npm_pkg files must include skills/**/*, package.json, README.md"

  # Stage tree integrity: every SKILL.md under plugins/<name>/skills/<bucket>/
  # (skipping in-progress/ and deprecated/) must exist byte-for-byte under
  # packaging/pi/<name>/skills/<bucket>/. The build script enforces this on
  # --check; here we just ensure the staged tree is non-empty so a missed
  # regeneration cannot ship a silent zero-skill package.
  local staged_skill_count
  staged_skill_count="$(find "packaging/pi/$plugin/skills" -name SKILL.md -print 2>/dev/null | wc -l)"
  [ "$staged_skill_count" -gt 0 ] \
    || fail "$plugin: staged packaging/pi/$plugin/skills has zero SKILL.md files"
}

validate_plugin dev
validate_plugin memory
validate_plugin internal

awk '
  /^  internal:[[:space:]]*$/ { in_internal = 1; next }
  /^  [^[:space:]][^:]*:/ { in_internal = 0 }
  in_internal && /^    enabled: true([[:space:]]+#.*)?$/ { found = 1 }
  END { exit found ? 0 : 1 }
' .red/config.yaml \
  || fail "internal: this repo must explicitly enable plugins.internal.enabled"

jq -e '.plugins[] | select(.name == "internal" and (.description | test("maintainer-only"; "i")))' \
  .agents/plugins/marketplace.json >/dev/null \
  || fail "internal: Codex marketplace description must mark it maintainer-only"

jq -e '.plugins[] | select(.name == "internal" and (.description | test("maintainer-only"; "i")))' \
  .claude-plugin/marketplace.json >/dev/null \
  || fail "internal: Claude marketplace description must mark it maintainer-only"

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
  plugins/memory/.codex-plugin/plugin.json \
  plugins/memory/.gemini-plugin/plugin.json; do
  jq -e '.dependencies | index("dev")' "$f" >/dev/null \
    || fail "memory: $f must declare a dependency on dev"
done

echo "install metadata ok"
