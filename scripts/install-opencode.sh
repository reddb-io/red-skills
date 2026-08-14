#!/usr/bin/env bash
# scripts/install-opencode.sh — install the RedSkills opencode-host
# adapter into a target directory or a user-scoped OpenCode-compatible config.
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
#   scripts/install-opencode.sh --global [--host opencode|redcode]
#   scripts/install-opencode.sh --uninstall [--global] [TARGET_DIR]
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
# The script is idempotent. Re-running replaces the install in place. Uninstall
# removes only files that are either recorded in the RedSkills manifest or still
# match RedSkills-generated/source content.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET_DIR=""
MODE="local"
ACTION="install"
COPY="false"
DRY_RUN="false"
CONFIG_PATH="$REPO_ROOT/.red/config.yaml"
PLUGINS_ROOT="$REPO_ROOT/plugins"
OUT_DIR="$REPO_ROOT/dist/opencode"
PREGENERATED_TREE_MARKER="$OUT_DIR/.release-generated"
MANIFEST_FILE=""
MANIFEST_TMP=""
HOST="opencode"
HOST_LABEL="OpenCode"
HOST_COMMAND="opencode"
HOST_CONFIG_DIR="opencode"

usage() {
  cat <<'EOF'
Usage: scripts/install-opencode.sh [TARGET_DIR]
                                  [--global]
                                  [--host opencode|redcode]
                                  [--uninstall]
                                  [--copy] [--dry-run]

Positional:
  TARGET_DIR              install into this directory (default: $PWD)

Options:
  --global                install into the selected host's user config
  --host <host>           OpenCode-compatible host (default: opencode)
  --uninstall             remove RedSkills files/config for the selected host
  --copy                  copy SKILL.md instead of symlinking
  --dry-run               print the steps, do not write

Examples:
  scripts/install-opencode.sh                         # install into $PWD
  scripts/install-opencode.sh /path/to/my-project
  scripts/install-opencode.sh --global                # user-scoped install
  scripts/install-opencode.sh --global --host redcode # ~/.config/redcode
  scripts/install-opencode.sh --uninstall --global    # remove user-scoped install
  scripts/install-opencode.sh --copy /path/to/project # cross-fs safety
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --global)  MODE="global" ;;
    --host)
      [ $# -ge 2 ] || { echo "error: --host requires a value" >&2; exit 2; }
      HOST="$2"
      shift
      ;;
    --uninstall) ACTION="uninstall" ;;
    --copy)    COPY="true" ;;
    --dry-run) DRY_RUN="true" ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "error: unknown arg $1" >&2; usage; exit 2 ;;
    *)  TARGET_DIR="$1" ;;
  esac
  shift
done

case "$HOST" in
  opencode)
    HOST_LABEL="OpenCode"
    HOST_COMMAND="opencode"
    HOST_CONFIG_DIR="opencode"
    ;;
  redcode)
    HOST_LABEL="RedCode"
    HOST_COMMAND="redcode"
    HOST_CONFIG_DIR="redcode"
    ;;
  *) printf 'install-opencode: unsupported host %s (expected opencode or redcode)\n' "$HOST" >&2; exit 1 ;;
esac

if [ "$MODE" = "local" ] && [ -z "$TARGET_DIR" ]; then
  TARGET_DIR="$PWD"
fi

log() { printf 'install-%s: %s\n' "$HOST" "$*"; }
die() { printf 'install-%s: %s\n' "$HOST" "$*" >&2; exit 1; }

run_rm() {
  path="$1"
  if [ "$DRY_RUN" = "true" ]; then
    log "(dry-run) remove $path"
    return 0
  fi
  rm -rf "$path"
}

begin_manifest() {
  MANIFEST_FILE="$1"
  [ "$DRY_RUN" = "false" ] || return 0
  mkdir -p "$(dirname "$MANIFEST_FILE")"
  MANIFEST_TMP="$MANIFEST_FILE.tmp-$$"
  {
    printf '# RedSkills %s install manifest\n' "$HOST_LABEL"
    printf '# One absolute path per line. Used by scripts/install-opencode.sh --uninstall.\n'
  } > "$MANIFEST_TMP"
}

record_manifest() {
  path="$1"
  [ -n "$MANIFEST_TMP" ] || return 0
  printf '%s\n' "$path" >> "$MANIFEST_TMP"
}

finish_manifest() {
  [ -n "$MANIFEST_TMP" ] || return 0
  mv "$MANIFEST_TMP" "$MANIFEST_FILE"
  log "wrote uninstall manifest $MANIFEST_FILE"
}

remove_manifest_paths() {
  manifest="$1"
  allowed_root="$2"
  [ -f "$manifest" ] || return 1

  while IFS= read -r path || [ -n "$path" ]; do
    case "$path" in
      ""|\#*) continue ;;
      "$allowed_root"/*)
        if [ -e "$path" ] || [ -L "$path" ]; then
          run_rm "$path"
        fi
        ;;
      *) log "(note) skipped manifest path outside $allowed_root: $path" ;;
    esac
  done < "$manifest"

  run_rm "$manifest"
  return 0
}

remove_generated_config() {
  file="$1"
  [ -f "$file" ] || return 0
  if head -n 1 "$file" | grep -Fq 'generated by @reddb-io/red-skills'; then
    run_rm "$file"
  else
    log "(note) kept $file because it is not a RedSkills-generated config"
  fi
}

write_expected_tui() {
  out="$1"
  cat > "$out" <<'TUI'
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
}

remove_redskills_tui() {
  file="$1"
  [ -f "$file" ] || return 0
  tmp="$(mktemp)"
  write_expected_tui "$tmp"
  if cmp -s "$file" "$tmp"; then
    rm -f "$tmp"
    run_rm "$file"
  else
    rm -f "$tmp"
    log "(note) kept $file because it no longer exactly matches the RedSkills TUI template"
  fi
}

remove_matching_source_skills() {
  target_skills_dir="$1"
  [ -d "$target_skills_dir" ] || return 0
  [ -d "$PLUGINS_ROOT" ] || {
    log "(note) no source plugins tree available; only manifest-recorded skills can be removed"
    return 0
  }

  ordered_plugins=""
  for preferred in dev memory brain; do
    [ -d "$PLUGINS_ROOT/$preferred" ] && ordered_plugins="$ordered_plugins $preferred"
  done
  for plugin_dir in "$PLUGINS_ROOT"/*; do
    [ -d "$plugin_dir" ] || continue
    plugin="$(basename "$plugin_dir")"
    case " $ordered_plugins " in
      *" $plugin "*) ;;
      *) ordered_plugins="$ordered_plugins $plugin" ;;
    esac
  done

  for plugin in $ordered_plugins; do
    [ -d "$PLUGINS_ROOT/$plugin/skills" ] || continue
    while IFS= read -r source_skill; do
      skill_name="$(basename "$(dirname "$source_skill")")"
      target_skill="$target_skills_dir/$skill_name/SKILL.md"
      if [ -e "$target_skill" ] && cmp -s "$target_skill" "$source_skill"; then
        run_rm "$target_skills_dir/$skill_name"
      fi
    done < <(find "$PLUGINS_ROOT/$plugin/skills" -name SKILL.md -type f | sort)
  done
}

remove_local_install() {
  TARGET_OC="$TARGET_DIR/.opencode"
  manifest="$TARGET_OC/redskills-install-manifest.txt"
  remove_manifest_paths "$manifest" "$TARGET_DIR" || true

  if [ -d "$TARGET_OC/plugin" ]; then
    for file in "$TARGET_OC/plugin"/*.ts; do
      [ -f "$file" ] || continue
      if grep -Fq 'generated by @reddb-io/red-skills' "$file"; then
        run_rm "$file"
      fi
    done
  fi

  remove_matching_source_skills "$TARGET_OC/skills"
  remove_generated_config "$TARGET_DIR/opencode.json"
  remove_generated_config "$TARGET_DIR/opencode.jsonc"
  remove_redskills_tui "$TARGET_DIR/tui.json"
  remove_redskills_tui "$TARGET_DIR/tui.jsonc"
  log "done. removed RedSkills $HOST_LABEL files from $TARGET_DIR"
}

remove_global_install() {
  XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
  OPENCODE_ROOT="$XDG_CONFIG_HOME/$HOST_CONFIG_DIR"
  GLOBAL_PLUGINS_DIR="$OPENCODE_ROOT/plugins"
  GLOBAL_SKILLS_DIR="$OPENCODE_ROOT/skills"
  manifest="$OPENCODE_ROOT/redskills-install-manifest.txt"

  remove_manifest_paths "$manifest" "$OPENCODE_ROOT" || true

  for file in "$GLOBAL_PLUGINS_DIR"/redskills-*.ts; do
    [ -e "$file" ] || continue
    run_rm "$file"
  done

  remove_matching_source_skills "$GLOBAL_SKILLS_DIR"
  remove_generated_config "$OPENCODE_ROOT/opencode.json"
  remove_generated_config "$OPENCODE_ROOT/opencode.jsonc"
  remove_redskills_tui "$OPENCODE_ROOT/tui.json"
  remove_redskills_tui "$OPENCODE_ROOT/tui.jsonc"
  log "done. removed RedSkills $HOST_LABEL files from $OPENCODE_ROOT"
}

if [ "$ACTION" = "uninstall" ]; then
  if [ "$MODE" = "local" ]; then
    remove_local_install
  else
    remove_global_install
  fi
  exit 0
fi

# 0. Preconditions
[ -f "$CONFIG_PATH" ] || die "config not found at $CONFIG_PATH — run from a red-skills clone"
[ -d "$PLUGINS_ROOT" ] || die "plugins tree not found at $PLUGINS_ROOT"

# 1. resolve the generator (release bundle preferred, tsx fallback)
BUNDLE="$REPO_ROOT/dist/opencode-host.bundle.min.mjs"
if [ "$DRY_RUN" = "true" ]; then
  GENERATOR="(tsx $REPO_ROOT/apps/opencode-host/src/generate.ts)"
elif [ -f "$BUNDLE" ]; then
  GENERATOR="node $BUNDLE"
else
  # Build-from-source fallback for checkout installs. The universal curl
  # installer downloads the release asset above, so normal user installs do not
  # need pnpm unless the asset is unavailable.
  if [ ! -d "$REPO_ROOT/node_modules" ]; then
    log "running pnpm install (first run)"
    (cd "$REPO_ROOT" && pnpm install --frozen-lockfile 2>/dev/null || pnpm install) >/dev/null
  fi
  log "bundle missing — building"
  (cd "$REPO_ROOT" && pnpm --filter @reddb-io/red-skills bundle) >/dev/null
  GENERATOR="node $BUNDLE"
fi

# 2. prepare the dist tree. Release installs prefer the pre-generated tree
# extracted by scripts/install.sh; source checkouts regenerate from the current
# tree so local development stays fresh.
if [ -f "$PREGENERATED_TREE_MARKER" ]; then
  log "using release-generated dist tree under $OUT_DIR"
else
  GEN_ARGS=(--config "$CONFIG_PATH" --plugins-root "$PLUGINS_ROOT" --out-dir "$OUT_DIR")
  [ "$COPY" = "true" ] && GEN_ARGS+=(--copy)

  log "generating dist tree under $OUT_DIR"
  if [ "$DRY_RUN" = "true" ]; then
    log "(dry-run) $GENERATOR ${GEN_ARGS[*]}"
  else
    (cd "$REPO_ROOT" && $GENERATOR "${GEN_ARGS[@]}")
  fi
fi

# 3. discover the plugins that have a dist subtree
PLUGINS=""
for d in "$OUT_DIR"/*/; do
  [ -d "$d" ] || continue
  name=$(basename "$d")
  [ -d "$d/.opencode" ] && PLUGINS="$PLUGINS $name"
done
PLUGINS="${PLUGINS# }"
[ -n "$PLUGINS" ] || die "no plugin dist trees under $OUT_DIR — the generator emitted nothing"

ORDERED_PLUGINS=""
for preferred in dev memory brain; do
  case " $PLUGINS " in
    *" $preferred "*) ORDERED_PLUGINS="$ORDERED_PLUGINS $preferred" ;;
  esac
done
for plugin in $PLUGINS; do
  case " $ORDERED_PLUGINS " in
    *" $plugin "*) ;;
    *) ORDERED_PLUGINS="$ORDERED_PLUGINS $plugin" ;;
  esac
done
PLUGINS="${ORDERED_PLUGINS# }"

# 5. install into the target
if [ "$MODE" = "local" ]; then
  TARGET_OC="$TARGET_DIR/.opencode"
  TARGET_CFG="$TARGET_DIR/opencode.json"
  if [ "$DRY_RUN" = "false" ]; then
    mkdir -p "$TARGET_OC/plugin" "$TARGET_OC/skills"
    begin_manifest "$TARGET_OC/redskills-install-manifest.txt"
  fi

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
    [ -d "$SRC/skills" ] && for skill_dir in "$SRC/skills"/*/; do
      [ -d "$skill_dir" ] || continue
      skill_name="$(basename "$skill_dir")"
      dst="$TARGET_OC/skills/$skill_name"
      if [ -e "$dst" ]; then
        log "(note) skill $skill_name already existed in $TARGET_OC/skills/ — left in place"
      else
        cp -R "$skill_dir" "$dst"
      fi
      [ -e "$dst/SKILL.md" ] && cmp -s "$dst/SKILL.md" "$skill_dir/SKILL.md" && record_manifest "$dst"
    done
    [ -d "$SRC/plugin" ] && for src_ts in "$SRC/plugin"/*.ts; do
      [ -f "$src_ts" ] || continue
      dst="$TARGET_OC/plugin/$(basename "$src_ts")"
      cp "$src_ts" "$dst"
      record_manifest "$dst"
    done
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

  finish_manifest
  log "done. run: cd $TARGET_DIR && $HOST_COMMAND ."
else
  # global mode
  XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
  HOST_ROOT="$XDG_CONFIG_HOME/$HOST_CONFIG_DIR"
  GLOBAL_PLUGINS_DIR="$HOST_ROOT/plugins"
  GLOBAL_SKILLS_DIR="$HOST_ROOT/skills"
  GLOBAL_CFG="$HOST_ROOT/opencode.json"
  [ -f "$HOST_ROOT/opencode.jsonc" ] && GLOBAL_CFG="$HOST_ROOT/opencode.jsonc"
  declare -A INSTALLED_SKILLS=()

  if [ "$DRY_RUN" = "true" ]; then
    log "(dry-run) flatten each plugin module into $GLOBAL_PLUGINS_DIR/redskills-<plugin>-<event>.ts"
    log "(dry-run) flatten each skill into $GLOBAL_SKILLS_DIR/<name>/SKILL.md"
    log "(dry-run) merge provider block into $GLOBAL_CFG"
  else
    mkdir -p "$GLOBAL_PLUGINS_DIR" "$GLOBAL_SKILLS_DIR"
    begin_manifest "$HOST_ROOT/redskills-install-manifest.txt"
    for plugin in $PLUGINS; do
      SRC="$OUT_DIR/$plugin/.opencode"
      [ -d "$SRC/plugin" ] && for src_ts in "$SRC/plugin"/*.ts; do
        [ -f "$src_ts" ] || continue
        event=$(basename "$src_ts" .ts)
        dst="$GLOBAL_PLUGINS_DIR/redskills-$plugin-$event.ts"
        cp "$src_ts" "$dst"
        record_manifest "$dst"
        log "installed $plugin/$event -> $dst"
      done
      [ -d "$SRC/skills" ] && for skill_dir in "$SRC/skills"/*/; do
        [ -d "$skill_dir" ] || continue
        skill_name=$(basename "$skill_dir")
        if [ -n "${INSTALLED_SKILLS[$skill_name]:-}" ]; then
          log "(note) duplicate skill $skill_name from $plugin skipped; already installed from ${INSTALLED_SKILLS[$skill_name]}"
          continue
        fi
        dst="$GLOBAL_SKILLS_DIR/$skill_name"
        rm -rf "$dst"
        cp -R "$skill_dir" "$dst"
        INSTALLED_SKILLS[$skill_name]="$plugin"
        record_manifest "$dst"
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
    # reads tui.json (or tui.jsonc) at the selected host config root
    # on every session start, so this enables the built-in
    # done / error / permission / question / subagent_done
    # sounds + notifications globally.
    GLOBAL_TUI="$HOST_ROOT/tui.json"
    [ -f "$HOST_ROOT/tui.jsonc" ] && GLOBAL_TUI="$HOST_ROOT/tui.jsonc"
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
    finish_manifest
  fi

  log "done. $HOST_COMMAND in any directory now picks up the same model + plugins."
fi
