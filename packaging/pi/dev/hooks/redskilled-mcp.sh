#!/usr/bin/env bash
set -u

root="${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}"
project_root="${RED_SKILLS_PROJECT_ROOT:-${CLAUDE_PROJECT_DIR:-${CODEX_PROJECT_DIR:-${OPENCODE_PROJECT_DIR:-}}}}"

if [ -n "$project_root" ]; then
  export RED_SKILLS_PROJECT_ROOT="$project_root"
fi

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

# red-dev moves this pointer only after it verifies and expands the complete
# package set. Once present, that resident bundle is the fastest and strongest
# identity available: no registry resolution belongs on every MCP handshake.
current_dist="$HOME/.red/skills/current/dist"
current_bundle="$current_dist/redskilled-mcp.bundle.min.mjs"
if [ -f "$current_bundle" ]; then
  # `current` is an atomic symlink. Execute the physical path because the
  # bundle's direct-entry guard compares argv[1] with its resolved import URL.
  physical_dist="$(cd "$current_dist" 2>/dev/null && pwd -P)"
  if [ -n "$physical_dist" ]; then
    exec node "$physical_dist/redskilled-mcp.bundle.min.mjs" "$@"
  fi
fi

# Source-checkout fallback for development before a workstation set is installed.
repo="$PWD"
if [ -f "$repo/pnpm-workspace.yaml" ] && \
   [ -f "$repo/apps/plugin-dev/package.json" ] && \
   [ -f "$repo/dist/redskilled-mcp.bundle.min.mjs" ]; then
  exec node "$repo/dist/redskilled-mcp.bundle.min.mjs" "$@"
fi

# A standalone plugin installation has no red-dev package set. Preserve the
# published, version-pinned npm path for that host, but keep it off the resident
# workstation path above.
if [ -n "$ver" ]; then
  exec npx -y -p "@reddb-io/red-skills@$ver" red-skills-redskilled-mcp "$@"
fi

printf 'redskilled: could not locate the redskilled-mcp bundle\n' >&2
exit 1
