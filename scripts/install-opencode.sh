#!/usr/bin/env bash
# scripts/install-opencode.sh — install the RedSkills opencode-host
# adapter into a target directory or the user-scoped OpenCode config.
#
# The generated OpenCode surface includes provider/model config, MCP servers,
# flat skills, plugin event modules, and TUI attention config. The generator
# emits plugin-local trees under ./dist/opencode/<plugin>/; this script merges
# them into either <target>/.opencode/ or ~/.config/opencode/.
#
# Usage:
#   scripts/install-opencode.sh [TARGET_DIR]
#   scripts/install-opencode.sh --copy   [TARGET_DIR]
#   scripts/install-opencode.sh --dry-run [TARGET_DIR]
#   scripts/install-opencode.sh --global
#
# Positional TARGET_DIR (default $PWD):
#   The directory to install into. The script writes:
#     <TARGET_DIR>/.opencode/plugin/   (plugin modules)
#     <TARGET_DIR>/.opencode/skills/   (skill symlinks/copies)
#     <TARGET_DIR>/opencode.json       (provider + model + MCP servers)
#     <TARGET_DIR>/tui.json            (attention sounds/notifications)
#   The user then runs `opencode <TARGET_DIR>` (or `cd <TARGET_DIR>
#   && opencode .`) and opencode auto-loads the .opencode subtree.
#
# --global: install into ~/.config/opencode/plugins/ instead. opencode
#   auto-loads .ts files from that directory but does NOT recurse into
#   sub-skills/. The global mode therefore flattens the .opencode/
#   subtree to a single plugin directory. Provider/MCP config is written to
#   ~/.config/opencode/opencode.json(c), and attention config is written to
#   ~/.config/opencode/tui.json(c). Existing config files are backed up first.
#
# --copy: copy SKILL.md into the target instead of symlinking. Use
#   this when the source tree is on a different filesystem than
#   $HOME (cross-fs symlinks are not portable).
#
# Preconditions:
#   - This script must be run from a clone of the red-skills repo
#     (or with a --config pointing at a .red/config.yaml that
#     already has plugins.dev.enabled: true). The opt-in gate is
#     fail-closed (ADR 0067); a missing enabled: true aborts the
#     install.
#   - pnpm install has been run at least once (the script runs it
#     automatically on the first invocation).
#
# The script is idempotent. Re-running replaces the install in place.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET_DIR=""
MODE="local"
COPY="false"
DRY_RUN="false"
CONFIG_PATH="$REPO_ROOT/.red/config.yaml"
PLUGINS_ROOT="$REPO_ROOT/plugins"
OUT_DIR="$REPO_ROOT/dist/opencode"

usage() {
  cat <<'EOF'
Usage: scripts/install-opencode.sh [TARGET_DIR]
                                  [--global]
                                  [--copy] [--dry-run]

Positional:
  TARGET_DIR              install into this directory (default: $PWD)

Options:
  --global                install into ~/.config/opencode/plugins/ instead
  --copy                  copy SKILL.md instead of symlinking
  --dry-run               print the steps, do not write

Examples:
  scripts/install-opencode.sh                         # install into $PWD
  scripts/install-opencode.sh /path/to/my-project
  scripts/install-opencode.sh --global                # user-scoped install
  scripts/install-opencode.sh --copy /path/to/project # cross-fs safety
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --global)  MODE="global" ;;
    --copy)    COPY="true" ;;
    --dry-run) DRY_RUN="true" ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "error: unknown arg $1" >&2; usage; exit 2 ;;
    *)  TARGET_DIR="$1" ;;
  esac
  shift
done

if [ "$MODE" = "local" ] && [ -z "$TARGET_DIR" ]; then
  TARGET_DIR="$PWD"
fi

log() { printf 'install-opencode: %s\n' "$*"; }
die() { printf 'install-opencode: %s\n' "$*" >&2; exit 1; }

# 0. Preconditions
[ -f "$CONFIG_PATH" ] || die "config not found at $CONFIG_PATH — run from a red-skills clone"
[ -d "$PLUGINS_ROOT" ] || die "plugins tree not found at $PLUGINS_ROOT"

# 1. pnpm install (first run only)
if [ ! -d "$REPO_ROOT/node_modules" ] && [ "$DRY_RUN" = "false" ]; then
  log "running pnpm install (first run)"
  (cd "$REPO_ROOT" && pnpm install --frozen-lockfile 2>/dev/null || pnpm install) >/dev/null
fi

# 2. resolve the generator (bundle preferred, tsx fallback)
BUNDLE="$REPO_ROOT/dist/opencode-host.bundle.min.mjs"
if [ "$DRY_RUN" = "true" ]; then
  GENERATOR="(tsx $REPO_ROOT/apps/opencode-host/src/generate.ts)"
elif [ -f "$BUNDLE" ]; then
  GENERATOR="node $BUNDLE"
else
  log "bundle missing — building"
  (cd "$REPO_ROOT" && pnpm --filter @reddb-io/red-skills bundle) >/dev/null
  GENERATOR="node $BUNDLE"
fi

# 3. generate the dist tree
GEN_ARGS=(--config "$CONFIG_PATH" --with-slice-2 --plugins-root "$PLUGINS_ROOT" --out-dir "$OUT_DIR")
[ "$COPY" = "true" ] && GEN_ARGS+=(--copy)

log "generating dist tree under $OUT_DIR"
if [ "$DRY_RUN" = "true" ]; then
  log "(dry-run) $GENERATOR ${GEN_ARGS[*]}"
else
  (cd "$REPO_ROOT" && $GENERATOR "${GEN_ARGS[@]}")
fi

# 4. discover the plugins that have a dist subtree
PLUGINS=""
for d in "$OUT_DIR"/*/; do
  [ -d "$d" ] || continue
  name=$(basename "$d")
  [ -d "$d/.opencode" ] && PLUGINS="$PLUGINS $name"
done
PLUGINS="${PLUGINS# }"
[ -n "$PLUGINS" ] || die "no plugin dist trees under $OUT_DIR — the generator emitted nothing"

# 5. install into the target
if [ "$MODE" = "local" ]; then
  TARGET_OC="$TARGET_DIR/.opencode"
  TARGET_CFG="$TARGET_DIR/opencode.json"
  [ "$DRY_RUN" = "false" ] && mkdir -p "$TARGET_OC/plugin" "$TARGET_OC/skills"

  for plugin in $PLUGINS; do
    SRC="$OUT_DIR/$plugin/.opencode"
    if [ "$DRY_RUN" = "true" ]; then
      log "(dry-run) merge $SRC into $TARGET_OC/"
      continue
    fi
    # Merge: skill symlinks/copies and plugin modules go into the
    # shared .opencode/ subtree. Multiple RedSkills plugins share
    # one .opencode/ root; a skill with the same name from two
    # plugins is a build error and would have been caught by the
    # Slice 2 name validation.
    cp -Rn "$SRC/skills/." "$TARGET_OC/skills/" 2>/dev/null || \
      log "(note) some skill symlinks/copies already existed in $TARGET_OC/skills/ — left in place"
    cp -R "$SRC/plugin/." "$TARGET_OC/plugin/"
    log "merged $plugin into $TARGET_OC/"
  done

  # Slice 1+3: write the standalone opencode.json (provider block +
  # MCP servers from every installed plugin, deduplicated). Slice 1
  # is now part of Slice 1+3 — the generator emits a single file
  # with `provider> + mcp:`, and the install script writes that
  # to the target root.
  if [ "$DRY_RUN" = "true" ]; then
    log "(dry-run) write $TARGET_CFG (Slice 1+3 provider block + MCP servers)"
  else
    STANDALONE_OUT="$TARGET_CFG.tmp-$$"
    (cd "$REPO_ROOT" && $GENERATOR --config "$CONFIG_PATH" --plugins-root "$PLUGINS_ROOT" --out "$STANDALONE_OUT") >/dev/null
    if [ -f "$STANDALONE_OUT" ]; then
      mv "$STANDALONE_OUT" "$TARGET_CFG"
      log "wrote $TARGET_CFG (provider block + MCP servers from $(echo $PLUGINS | wc -w) plugin(s))"
    else
      cp "$OUT_DIR/dev/opencode.json" "$TARGET_CFG"
      log "(warning) standalone emit failed; fell back to per-plugin opencode.json"
    fi
  fi

  # Slice 4: write tui.json to the project root with attention
  # enabled (built-in done/error/permission/question sounds +
  # notifications). The user can rename it to tui.jsonc and move
  # it to ~/.config/opencode/ to make it user-scoped.
  TARGET_TUI="$TARGET_DIR/tui.json"
  if [ "$DRY_RUN" = "true" ]; then
    log "(dry-run) write $TARGET_TUI (Slice 4: tui.json with attention.enabled)"
  else
    cat > "$TARGET_TUI" <<'TUI'
{
  "$schema": "https://opencode.ai/tui.json",
  "attention": {
    "enabled": true,
    "notifications": true,
    "sound": true,
    "volume": 0.4
  }
}
TUI
    log "wrote $TARGET_TUI (Slice 4: tui.json with attention.enabled; move to ~/.config/opencode/ to make it user-scoped)"
  fi

  log "done. run: cd $TARGET_DIR && opencode ."
else
  # global mode
  XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
  GLOBAL_PLUGINS_DIR="$XDG_CONFIG_HOME/opencode/plugins"
  GLOBAL_SKILLS_DIR="$XDG_CONFIG_HOME/opencode/skills"
  GLOBAL_CFG="$XDG_CONFIG_HOME/opencode/opencode.json"
  [ -f "$XDG_CONFIG_HOME/opencode/opencode.jsonc" ] && GLOBAL_CFG="$XDG_CONFIG_HOME/opencode/opencode.jsonc"

  if [ "$DRY_RUN" = "true" ]; then
    log "(dry-run) flatten each plugin module into $GLOBAL_PLUGINS_DIR/redskills-<plugin>-<event>.ts"
    log "(dry-run) flatten each skill into $GLOBAL_SKILLS_DIR/<name>/SKILL.md"
    log "(dry-run) merge provider block into $GLOBAL_CFG"
  else
    mkdir -p "$GLOBAL_PLUGINS_DIR" "$GLOBAL_SKILLS_DIR"
    for plugin in $PLUGINS; do
      SRC="$OUT_DIR/$plugin/.opencode"
      [ -d "$SRC/plugin" ] && for src_ts in "$SRC/plugin"/*.ts; do
        [ -f "$src_ts" ] || continue
        event=$(basename "$src_ts" .ts)
        dst="$GLOBAL_PLUGINS_DIR/redskills-$plugin-$event.ts"
        cp "$src_ts" "$dst"
        log "installed $plugin/$event -> $dst"
      done
      [ -d "$SRC/skills" ] && for skill_dir in "$SRC/skills"/*/; do
        [ -d "$skill_dir" ] || continue
        skill_name=$(basename "$skill_dir")
        dst="$GLOBAL_SKILLS_DIR/$skill_name"
        rm -rf "$dst"
        cp -R "$skill_dir" "$dst"
        log "installed skill $skill_name -> $dst"
      done
    done

    # Merge provider block + MCP servers into the user's
    # opencode.json(c). The generator emits a single standalone
    # file with `provider> + mcp:` (Slice 1+3) for the global
    # install; the per-plugin dist files are not used here because
    # the global config is a single file, not a per-plugin tree.
    if [ -f "$GLOBAL_CFG" ] && [ -s "$GLOBAL_CFG" ] && [ "$(cat "$GLOBAL_CFG" 2>/dev/null)" != "{}" ]; then
      backup="$GLOBAL_CFG.backup-$(date +%Y%m%d%H%M%S)"
      cp "$GLOBAL_CFG" "$backup"
      log "backed up existing $GLOBAL_CFG -> $backup"
    fi
    STANDALONE_OUT="$GLOBAL_CFG.tmp-$$"
    (cd "$REPO_ROOT" && $GENERATOR --config "$CONFIG_PATH" --plugins-root "$PLUGINS_ROOT" --out "$STANDALONE_OUT") >/dev/null
    if [ -f "$STANDALONE_OUT" ]; then
      mv "$STANDALONE_OUT" "$GLOBAL_CFG"
      log "wrote $GLOBAL_CFG (provider block + MCP servers)"
    else
      cp "$OUT_DIR/dev/opencode.json" "$GLOBAL_CFG"
      log "(warning) standalone emit failed; fell back to per-plugin opencode.json"
    fi

    # Slice 4: merge the tui.json with attention.enabled. opencode
    # reads tui.json (or tui.jsonc) at $XDG_CONFIG_HOME/opencode/
    # on every session start, so this enables the built-in
    # done / error / permission / question / subagent_done
    # sounds + notifications globally.
    GLOBAL_TUI="$XDG_CONFIG_HOME/opencode/tui.json"
    [ -f "$XDG_CONFIG_HOME/opencode/tui.jsonc" ] && GLOBAL_TUI="$XDG_CONFIG_HOME/opencode/tui.jsonc"
    if [ "$DRY_RUN" = "true" ]; then
      log "(dry-run) write $GLOBAL_TUI (Slice 4: tui.json with attention.enabled)"
    else
      if [ -f "$GLOBAL_TUI" ] && [ -s "$GLOBAL_TUI" ] && [ "$(cat "$GLOBAL_TUI" 2>/dev/null)" != "{}" ]; then
        backup="$GLOBAL_TUI.backup-$(date +%Y%m%d%H%M%S)"
        cp "$GLOBAL_TUI" "$backup"
        log "backed up existing $GLOBAL_TUI -> $backup"
      fi
      cat > "$GLOBAL_TUI" <<'TUI'
{
  "$schema": "https://opencode.ai/tui.json",
  "attention": {
    "enabled": true,
    "notifications": true,
    "sound": true,
    "volume": 0.4
  }
}
TUI
      log "wrote $GLOBAL_TUI (Slice 4: tui.json with attention.enabled)"
    fi
  fi

  log "done. opencode in any directory now picks up the same model + plugins."
fi
