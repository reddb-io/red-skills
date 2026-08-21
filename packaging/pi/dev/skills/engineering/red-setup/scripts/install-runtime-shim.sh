#!/usr/bin/env bash
set -euo pipefail

bin_dir="${XDG_BIN_HOME:-$HOME/.local/bin}"
name="${1:-red-skills-dev}"
dev_target="$bin_dir/$name"
rsp_target="$bin_dir/rsp"

mkdir -p "$bin_dir"

cat >"$dev_target" <<'SH'
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

# There is deliberately NO cached-bundle fallback here. ADR 0147 deleted the dev
# runtime bundle, so `dev-3.21.0.bundle.min.mjs` is the last one that will ever
# exist and resolving it runs a 3.21.0-era binary against v4 state. A machine
# that still holds one gets the message below, not silently old code.

launcher="$(env_launcher || true)"
if [ -n "$launcher" ]; then
  exec node "$launcher" "$@"
fi

launcher="$(latest_cache_launcher || true)"
if [ -n "$launcher" ]; then
  exec node "$launcher" "$@"
fi

cat >&2 <<'EOF'
red-skills-dev: no RedSkills dev runtime found.

Expected one of:
- an installed dev plugin under ~/.codex/plugins/cache/red-skills/dev/*
- an installed dev plugin under ~/.claude/plugins/cache/red-skills/dev/*

The dev runtime bundle was deleted by ADR 0147; any leftover
~/.cache/red-skills/bundles/dev-*.bundle.min.mjs is inert and safe to remove.

Fallback:
  npx -y -p @reddb-io/red-skills@<version> red-skills-dev "$@"

Run /red-setup in a repo with plugins.dev.enabled: true, then restart the
agent session so the plugin SessionStart hook can warm the runtime cache, or use
the npm direct-run fallback above for a fresh machine.
EOF
exit 127
SH

cat >"$rsp_target" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

env_bundle() {
  local root bundle
  for root in \
    "${RED_SKILLS_DEV_PLUGIN_ROOT:-}" \
    "${CLAUDE_PLUGIN_ROOT:-}" \
    "${CODEX_PLUGIN_ROOT:-}" \
    "${OPENCODE_PLUGIN_ROOT:-}"
  do
    [ -n "$root" ] || continue
    for bundle in \
      "$root/../../dist/rsp.bundle.min.mjs" \
      "$root/dist/rsp.bundle.min.mjs"
    do
      if [ -f "$bundle" ]; then
        printf '%s\n' "$bundle"
        return 0
      fi
    done
  done
  return 1
}

latest_cache_bundle() {
  local dir bundle
  for dir in "$HOME"/.codex/plugins/cache/red-skills/dev/* "$HOME"/.claude/plugins/cache/red-skills/dev/*; do
    [ -d "$dir" ] || continue
    for bundle in "$dir/../../dist/rsp.bundle.min.mjs" "$dir/dist/rsp.bundle.min.mjs"; do
      [ -f "$bundle" ] &&
        printf '%s\t%s\n' "$(basename "$dir")" "$bundle"
    done
  done | sort -V | tail -1 | cut -f2-
}

latest_bundle() {
  local cache_root bundle version
  cache_root="${RED_SKILLS_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/red-skills/bundles}"

  if [ -f "$cache_root/rsp.bundle.min.mjs" ]; then
    printf '%s\n' "$cache_root/rsp.bundle.min.mjs"
    return 0
  fi

  for bundle in "$cache_root"/rsp-*.bundle.min.mjs; do
    [ -f "$bundle" ] || continue
    version="${bundle##*/rsp-}"
    version="${version%.bundle.min.mjs}"
    printf '%s\t%s\n' "$version" "$bundle"
  done | sort -V | tail -1 | cut -f2-
}

find_red_binary() {
  local cache_root red version
  cache_root="${RED_SKILLS_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/red-skills/bundles}"

  for red in "$cache_root"/reddb/*/red "$cache_root"/reddb/*/red.exe; do
    [ -x "$red" ] || continue
    version="${red%/*}"
    version="${version##*/}"
    printf '%s\t%s\n' "$version" "$red"
  done | sort -V | tail -1 | cut -f2-
}

with_red_binary() {
  local red
  red="$(find_red_binary || true)"
  if [ -n "$red" ]; then
    REDDB_BIN="$red" exec node "$@"
  fi
  exec node "$@"
}

bundle="$(env_bundle || true)"
if [ -n "$bundle" ]; then
  with_red_binary "$bundle" "$@"
fi

bundle="$(latest_cache_bundle || true)"
if [ -n "$bundle" ]; then
  with_red_binary "$bundle" "$@"
fi

bundle="$(latest_bundle || true)"
if [ -n "$bundle" ]; then
  with_red_binary "$bundle" "$@"
fi

cat >&2 <<'EOF'
rsp: no RedSkills rsp runtime found.

Expected one of:
- an installed dev plugin with dist/rsp.bundle.min.mjs under ~/.codex/plugins/cache/red-skills/dev/*
- an installed dev plugin with dist/rsp.bundle.min.mjs under ~/.claude/plugins/cache/red-skills/dev/*
- a warmed rsp bundle under ${RED_SKILLS_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/red-skills/bundles}

Run /red-setup in a repo with plugins.dev.enabled: true, then restart the
agent session so the plugin SessionStart hook can warm the runtime cache.
EOF
exit 127
SH

chmod 0755 "$dev_target" "$rsp_target"
printf 'installed %s\n' "$dev_target"
printf 'installed %s\n' "$rsp_target"
