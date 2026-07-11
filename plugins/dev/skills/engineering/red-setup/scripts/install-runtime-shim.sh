#!/usr/bin/env bash
set -euo pipefail

bin_dir="${XDG_BIN_HOME:-$HOME/.local/bin}"
name="${1:-red-skills-dev}"
target="$bin_dir/$name"

mkdir -p "$bin_dir"

cat >"$target" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

env_launcher() {
  local root
  for root in \
    "${RED_SKILLS_DEV_PLUGIN_ROOT:-}" \
    "${CLAUDE_PLUGIN_ROOT:-}" \
    "${CODEX_PLUGIN_ROOT:-}" \
    "${OPENCODE_PLUGIN_ROOT:-}"
  do
    [ -n "$root" ] || continue
    if [ -f "$root/skills/engineering/afk/bin/afk.mjs" ]; then
      printf '%s\n' "$root/skills/engineering/afk/bin/afk.mjs"
      return 0
    fi
  done
  return 1
}

latest_cache_launcher() {
  local dir
  for dir in "$HOME"/.codex/plugins/cache/red-skills/dev/* "$HOME"/.claude/plugins/cache/red-skills/dev/*; do
    [ -f "$dir/skills/engineering/afk/bin/afk.mjs" ] &&
      printf '%s\t%s\n' "$(basename "$dir")" "$dir/skills/engineering/afk/bin/afk.mjs"
  done | sort -V | tail -1 | cut -f2-
}

latest_bundle() {
  local bundle
  for bundle in "$HOME"/.cache/red-skills/bundles/dev-*.bundle.min.mjs; do
    [ -f "$bundle" ] || continue
    local version="${bundle##*/dev-}"
    version="${version%.bundle.min.mjs}"
    printf '%s\t%s\n' "$version" "$bundle"
  done | sort -V | tail -1 | cut -f2-
}

launcher="$(env_launcher || true)"
if [ -n "$launcher" ]; then
  exec node "$launcher" "$@"
fi

launcher="$(latest_cache_launcher || true)"
if [ -n "$launcher" ]; then
  exec node "$launcher" "$@"
fi

bundle="$(latest_bundle || true)"
if [ -n "$bundle" ]; then
  exec node "$bundle" "$@"
fi

cat >&2 <<'EOF'
red-skills-dev: no RedSkills dev runtime found.

Expected one of:
- an installed dev plugin under ~/.codex/plugins/cache/red-skills/dev/*
- an installed dev plugin under ~/.claude/plugins/cache/red-skills/dev/*
- a warmed bundle under ~/.cache/red-skills/bundles/dev-*.bundle.min.mjs

Run /red-setup in a repo with plugins.dev.enabled: true, then restart the
agent session so the plugin SessionStart hook can warm the runtime cache.
EOF
exit 127
SH

chmod 0755 "$target"
printf 'installed %s\n' "$target"
