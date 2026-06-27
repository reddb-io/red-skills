#!/usr/bin/env bash
# scripts/install-opencode.sh — install the RedSkills opencode-host
# adapter (Slice 1 + Slice 2) into a target directory.
#
# Slice 1 + Slice 2 are the opencode-native surface: a provider block
# (Slice 1) plus the .opencode/skills/<name>/SKILL.md and
# .opencode/plugin/<event>.ts files opencode auto-loads (Slice 2).
# The generator emits this surface under ./dist/opencode/<plugin>/;
# this script copies/symlinks it into the target directory's .opencode/
# and writes the opencode.json provider block at the target root.
#
# Usage:
#   scripts/install-opencode.sh [TARGET_DIR]
#   scripts/install-opencode.sh --copy   [TARGET_DIR]
#   scripts/install-opencode.sh --dry-run [TARGET_DIR]
#   scripts/install-opencode.sh --global
#
# Positional TARGET_DIR (default $PWD):
#   The directory to install into. The script writes:
#     <TARGET_DIR>/.opencode/plugin/   (Slice 2 hook modules)
#     <TARGET_DIR>/.opencode/skills/   (Slice 2 skill symlinks/copies)
#     <TARGET_DIR>/opencode.json       (Slice 1 provider block)
#   The user then runs `opencode <TARGET_DIR>` (or `cd <TARGET_DIR>
#   && opencode .`) and opencode auto-loads the .opencode subtree.
#
# --global: install into ~/.config/opencode/plugins/ instead. opencode
#   auto-loads .ts files from that directory but does NOT recurse into
#   sub-skills/. The global mode therefore flattens the .opencode/
#   subtree to a single plugin directory. The provider block is
#   written to ~/.config/opencode/opencode.json(c) (the existing file
#   is preserved; the script merges the new provider entries in).
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
  (cd "$REPO_ROOT" && pnpm --filter @redskills/opencode-host bundle) >/dev/null
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

  # Slice 1: write the provider block at the target root
  if [ "$DRY_RUN" = "true" ]; then
    log "(dry-run) write $TARGET_CFG (Slice 1 provider block)"
  else
    cp "$OUT_DIR/dev/opencode.json" "$TARGET_CFG"
    log "wrote $TARGET_CFG (provider block; plugin list auto-loaded from $TARGET_OC/)"
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

    # Merge provider block into the user's opencode.json(c). The
    # generator emits a single file per plugin; for global install
    # we use the dev plugin's provider block (the only one whose
    # provider entries depend on .red/config.yaml — memory and
    # brain share the same block today). If the user's config
    # already has content, back it up so a re-run is safe.
    if [ -f "$GLOBAL_CFG" ] && [ -s "$GLOBAL_CFG" ] && [ "$(cat "$GLOBAL_CFG" 2>/dev/null)" != "{}" ]; then
      backup="$GLOBAL_CFG.backup-$(date +%Y%m%d%H%M%S)"
      cp "$GLOBAL_CFG" "$backup"
      log "backed up existing $GLOBAL_CFG -> $backup"
    fi
    cp "$OUT_DIR/dev/opencode.json" "$GLOBAL_CFG"
    log "wrote $GLOBAL_CFG (provider block)"
  fi

  log "done. opencode in any directory now picks up the same model + plugins."
fi
