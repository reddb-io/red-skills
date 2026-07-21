#!/bin/sh
set -u

root="${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}"

if [ -z "$root" ]; then
  for candidate in \
    "$PWD/plugins/dev" \
    "$HOME/.codex/.tmp/marketplaces/red-skills/plugins/dev"; do
    if [ -f "$candidate/.codex-plugin/plugin.json" ] || [ -f "$candidate/.claude-plugin/plugin.json" ]; then
      root="$candidate"
      break
    fi
  done
fi

plugin_json=""
if [ -n "$root" ] && [ -f "$root/.codex-plugin/plugin.json" ]; then
  plugin_json="$root/.codex-plugin/plugin.json"
elif [ -n "$root" ] && [ -f "$root/.claude-plugin/plugin.json" ]; then
  plugin_json="$root/.claude-plugin/plugin.json"
fi

ver=""
if [ -n "$plugin_json" ]; then
  ver="$(node -e "process.stdout.write(require(process.argv[1]).version)" "$plugin_json" 2>/dev/null || true)"
fi

if [ -n "$ver" ]; then
  npx -y -p "@reddb-io/red-skills@$ver" red-skills-afk-mcp
  status=$?
  if [ "$status" -eq 0 ]; then
    exit 0
  fi
  printf 'dev:afk: npm package launcher failed for %s (exit %s); trying local dist fallback\n' "$ver" "$status" >&2
fi

for repo in "$root/../.." "$PWD"; do
  if [ -f "$repo/dist/afk-mcp.bundle.min.mjs" ]; then
    exec node "$repo/dist/afk-mcp.bundle.min.mjs"
  fi
done

printf 'dev:afk: could not locate afk-mcp.bundle.min.mjs\n' >&2
exit 1
