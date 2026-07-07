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

cache="${RED_SKILLS_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/red-skills/bundles}"
bundle=""

if [ -n "$ver" ] && [ -f "$cache/code-nav-$ver.bundle.min.mjs" ]; then
  bundle="$cache/code-nav-$ver.bundle.min.mjs"
fi

if [ -z "$bundle" ] && [ -n "$root" ] && [ -n "$ver" ]; then
  for fetcher in \
    "$root/hooks/red-fetch.mjs" \
    "$root/dist/red-fetch.mjs" \
    "$root/../../dist/red-fetch.mjs"; do
    if [ -f "$fetcher" ]; then
      node "$fetcher" code-nav "$ver" >/dev/null 2>&1 || true
      break
    fi
  done

  if [ -f "$cache/code-nav-$ver.bundle.min.mjs" ]; then
    bundle="$cache/code-nav-$ver.bundle.min.mjs"
  fi
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
  printf 'code-nav: could not locate code-nav-mcp bundle for %s (looked in cache %s and repo-root dist; red-fetch on-demand also failed)\\n' "$expected" "$cache" >&2
  exit 0
fi

exec node "$bundle"
