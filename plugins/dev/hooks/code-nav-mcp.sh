#!/usr/bin/env bash
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

if [ -z "$root" ] && [ -d "$HOME/.codex/plugins/cache/red-skills/dev" ]; then
  for candidate in "$HOME/.codex/plugins/cache/red-skills/dev"/*; do
    if [ -f "$candidate/.codex-plugin/plugin.json" ] || [ -f "$candidate/.claude-plugin/plugin.json" ]; then
      root="$candidate"
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

bundle=""

if [ -n "$ver" ]; then
  npx -y -p "@reddb-io/red-skills@$ver" red-skills-code-nav
  status=$?
  if [ "$status" -eq 0 ]; then
    exit 0
  fi
  printf 'code-nav: npm package launcher failed for %s (exit %s); trying local dist fallback\n' "$ver" "$status" >&2
fi

if [ -z "$bundle" ]; then
  for repo in "$root/../.." "$PWD"; do
    if [ -f "$repo/dist/code-nav-mcp.bundle.min.mjs" ]; then
      bundle="$repo/dist/code-nav-mcp.bundle.min.mjs"
      break
    fi
  done
fi

if [ -z "$bundle" ]; then
  expected="${ver:-<unknown>}"
  printf 'code-nav: could not launch red-skills-code-nav for %s and could not locate repo-root dist fallback\n' "$expected" >&2
  exit 0
fi

exec node "$bundle"
