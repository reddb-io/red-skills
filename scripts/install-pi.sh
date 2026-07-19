#!/usr/bin/env bash
# scripts/install-pi.sh — install the RedSkills Pi packages into Pi's user or
# project settings.
#
# Pi packages are installed via `pi install <local-path>` and registered in
# ~/.pi/agent/settings.json (user scope) or <target>/.pi/settings.json
# (project scope). This script resolves the released RedSkills checkout,
# calls `pi install` once per published plugin (dev/memory/brain), and
# records the resulting settings file plus the per-plugin local-path entries
# so a subsequent --uninstall cleanly removes them.
#
# Usage:
#   scripts/install-pi.sh [--user] [--project TARGET_DIR]
#   scripts/install-pi.sh --uninstall [--user] [--project TARGET_DIR]
#   scripts/install-pi.sh --dry-run
#
# --user: install packages into ~/.pi/agent/settings.json (default).
# --project TARGET_DIR: install packages into <TARGET_DIR>/.pi/settings.json.
#   Use this for repo-scoped installs that ship with the repo so teammates
#   pick up the same RedSkills skills on first launch.
# --uninstall: remove every package this script previously installed from
#   the selected scope, and delete the manifest file we wrote.
# --dry-run: print the steps without invoking `pi install`/`pi remove` or
#   writing any manifest.
#
# Exit codes: 0 success; 1 `pi` not installed or `pi install` failed;
# 2 usage error.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ACTION="install"
SCOPE="user"
TARGET_DIR=""
DRY_RUN="false"

usage() {
  cat <<'EOF'
Usage: scripts/install-pi.sh [--user | --project TARGET_DIR]
                              [--uninstall] [--dry-run]

Options:
  --user                  install into ~/.pi/agent/settings.json (default)
  --project TARGET_DIR    install into <TARGET_DIR>/.pi/settings.json
  --uninstall             remove packages this script previously installed
  --dry-run               print actions without invoking `pi` or writing files
  -h, --help              show this help

Examples:
  scripts/install-pi.sh                           # user-scoped install
  scripts/install-pi.sh --project /path/to/repo   # project-scoped install
  scripts/install-pi.sh --uninstall               # user-scoped uninstall
  scripts/install-pi.sh --project . --dry-run     # inspect project install
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --user)
      SCOPE="user"
      shift
      ;;
    --project)
      [ $# -ge 2 ] || { echo "error: --project requires a path" >&2; usage; exit 2; }
      SCOPE="project"
      TARGET_DIR="$2"
      shift 2
      ;;
    --uninstall)
      ACTION="uninstall"
      shift
      ;;
    --dry-run)
      DRY_RUN="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [ "$SCOPE" = "project" ] && [ -z "$TARGET_DIR" ]; then
  echo "error: --project requires a path" >&2
  usage
  exit 2
fi

if [ "$SCOPE" = "project" ]; then
  TARGET_DIR="$(cd "$TARGET_DIR" && pwd)"
fi

SETTINGS_FILE="$([ "$SCOPE" = "user" ] && printf '%s' "$HOME/.pi/agent/settings.json" || printf '%s' "$TARGET_DIR/.pi/settings.json")"
MANIFEST_FILE="$([ "$SCOPE" = "user" ] && printf '%s' "$HOME/.pi/agent/redskills-install-manifest.json" || printf '%s' "$TARGET_DIR/.pi/redskills-install-manifest.json")"
INSTALLED_PLUGINS=(dev memory brain)

log() { printf 'install-pi: %s\n' "$*"; }
die() { printf 'install-pi: %s\n' "$*" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required"
}

if [ "$DRY_RUN" != "true" ]; then
  require_cmd pi
  require_cmd jq
fi

# Generate the per-plugin package.json manifests if they are missing or stale.
regenerate_manifests() {
  if [ "$DRY_RUN" = "true" ]; then
    log "(dry-run) would run scripts/generate-pi-manifests.mjs"
    return 0
  fi
  if [ ! -f "$REPO_ROOT/scripts/generate-pi-manifests.mjs" ]; then
    die "scripts/generate-pi-manifests.mjs is missing from the source checkout"
  fi
  node "$REPO_ROOT/scripts/generate-pi-manifests.mjs" --root "$REPO_ROOT" \
    || die "pi manifest generation failed"
}

assert_settings_file_present() {
  [ -f "$SETTINGS_FILE" ] \
    || die "Pi settings file is missing: $SETTINGS_FILE. Run \`pi\` once interactively to create it."
}

read_manifest() {
  [ -f "$MANIFEST_FILE" ] || return 0
  jq -r '.plugins[]? | "\(.name)\t\(.path)"' "$MANIFEST_FILE"
}

write_manifest() {
  local plugin_name="$1"
  local source_path="$2"
  local tmp
  tmp="$(mktemp)"
  if [ -f "$MANIFEST_FILE" ]; then
    jq --arg name "$plugin_name" --arg path "$source_path" \
      '.plugins |= map(select(.name != $name)) + [{name: $name, path: $path}]' \
      "$MANIFEST_FILE" > "$tmp"
  else
    mkdir -p "$(dirname "$MANIFEST_FILE")"
    jq -n --arg name "$plugin_name" --arg path "$source_path" \
      '{version: 1, scope: "'"$SCOPE"'", settings_file: "'"$SETTINGS_FILE"'", plugins: [{name: $name, path: $path}]}' \
      > "$tmp"
  fi
  mv "$tmp" "$MANIFEST_FILE"
}

remove_from_manifest() {
  local plugin_name="$1"
  [ -f "$MANIFEST_FILE" ] || return 0
  local tmp
  tmp="$(mktemp)"
  jq --arg name "$plugin_name" '.plugins |= map(select(.name != $name))' \
    "$MANIFEST_FILE" > "$tmp"
  mv "$tmp" "$MANIFEST_FILE"
}

invoke_pi_install() {
  local plugin_name="$1"
  local source_path="$2"
  if [ "$DRY_RUN" = "true" ]; then
    log "(dry-run) would run: pi install $source_path"
    log "(dry-run) manifest entry: $plugin_name -> $source_path ($SETTINGS_FILE)"
    return 0
  fi
  log "installing $plugin_name via \`pi install $source_path\`"
  if [ "$SCOPE" = "project" ]; then
    ( cd "$TARGET_DIR" && pi install -l "$source_path" )
  else
    pi install "$source_path"
  fi
  write_manifest "$plugin_name" "$source_path"
}

invoke_pi_remove() {
  local plugin_name="$1"
  local source_path="$2"
  if [ "$DRY_RUN" = "true" ]; then
    log "(dry-run) would run: pi remove $source_path"
    log "(dry-run) manifest entry: $plugin_name -> $source_path"
    return 0
  fi
  log "removing $plugin_name via \`pi remove $source_path\`"
  pi remove "$source_path" || warn "pi remove reported an error for $plugin_name (continuing)"
  remove_from_manifest "$plugin_name"
}

warn() { printf 'install-pi: warn: %s\n' "$*" >&2; }

run_install() {
  if [ "$DRY_RUN" != "true" ]; then
    assert_settings_file_present
  fi
  regenerate_manifests
  local plugin_dir
  for plugin in "${INSTALLED_PLUGINS[@]}"; do
    plugin_dir="$REPO_ROOT/plugins/$plugin"
    if [ ! -d "$plugin_dir" ]; then
      warn "skipping $plugin: source dir $plugin_dir not found"
      continue
    fi
    invoke_pi_install "$plugin" "$plugin_dir"
  done
  if [ "$DRY_RUN" = "true" ]; then
    log "(dry-run) would record manifest at $MANIFEST_FILE"
  else
    log "wrote install manifest $MANIFEST_FILE"
  fi
  log "restart any open pi sessions so the new skills reload"
}

run_uninstall() {
  if [ "$DRY_RUN" != "true" ]; then
    assert_settings_file_present
  fi
  if [ ! -f "$MANIFEST_FILE" ]; then
    warn "no manifest at $MANIFEST_FILE; nothing to remove"
    return 0
  fi
  local seen_plugin
  seen_plugin=""
  while IFS=$'\t' read -r plugin_name source_path; do
    [ -n "$plugin_name" ] || continue
    invoke_pi_remove "$plugin_name" "$source_path"
    seen_plugin="$seen_plugin $plugin_name"
  done < <(read_manifest)
  if [ "$DRY_RUN" = "true" ]; then
    log "(dry-run) would retain manifest at $MANIFEST_FILE"
  else
    # Remove the manifest file once empty so a fresh install starts clean.
    local remaining
    remaining="$(jq -r '.plugins | length' "$MANIFEST_FILE" 2>/dev/null || echo 0)"
    if [ "$remaining" = "0" ]; then
      rm -f "$MANIFEST_FILE"
      log "removed empty manifest $MANIFEST_FILE"
    fi
  fi
  log "restart any open pi sessions so the removed skills unload"
}

case "$ACTION" in
  install) run_install ;;
  uninstall) run_uninstall ;;
  *) die "internal: unknown ACTION $ACTION" ;;
esac