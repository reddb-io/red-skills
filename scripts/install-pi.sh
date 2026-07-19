#!/usr/bin/env bash
# scripts/install-pi.sh — install the RedSkills Pi packages into Pi's user or
# project settings.
#
# Two install surfaces, picked automatically:
#
#   1. npm-distributed (default; ADR 0110): the public user path.
#      `pi install npm:@reddb-io/red-skills-<plugin>` once per published plugin
#      (dev/memory/brain/internal). Auto-updates via `pi update --all`.
#      No source checkout required.
#
#   2. local-path (--source-dir <path>; ADR 0110 dev path): for in-repo
#      development and offline use. Calls `pi install <path>` per plugin.
#      Auto-updates only via `git pull` inside <path>.
#
# The two surfaces share the same manifest at
# ~/.pi/agent/redskills-install-manifest.json (or
# <target>/.pi/redskills-install-manifest.json for --project), so a single
# `--uninstall` cleanly tears down whichever surface was used.
#
# Usage:
#   scripts/install-pi.sh [--user] [--project TARGET_DIR] [--source-dir PATH]
#   scripts/install-pi.sh --uninstall [--user] [--project TARGET_DIR]
#   scripts/install-pi.sh --dry-run
#
# Environment:
#   RED_SKILLS_PI_VERSION — pin the npm-installed version (default: latest).
#                            Ignored when --source-dir is set.
#
# Exit codes: 0 success; 1 `pi` not installed or `pi install` failed;
# 2 usage error.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ACTION="install"
SCOPE="user"
TARGET_DIR=""
DRY_RUN="false"
SOURCE_DIR=""
NPM_SCOPE="@reddb-io"
INSTALLED_PLUGINS=(dev memory brain internal)
PIN_VERSION="${RED_SKILLS_PI_VERSION:-}"

usage() {
  cat <<'EOF'
Usage: scripts/install-pi.sh [--user | --project TARGET_DIR] [--source-dir PATH]
                              [--uninstall] [--dry-run]

Options:
  --user                  install into ~/.pi/agent/settings.json (default)
  --project TARGET_DIR    install into <TARGET_DIR>/.pi/settings.json
  --source-dir PATH       use the local checkout at PATH instead of npm
                          (dev/offline path; ADR 0110)
  --uninstall             remove packages this script previously installed
  --dry-run               print actions without invoking `pi` or writing files
  -h, --help              show this help

Examples:
  scripts/install-pi.sh                                  # user-scoped, latest npm
  scripts/install-pi.sh --project /path/to/repo          # project-scoped, npm
  scripts/install-pi.sh --source-dir /path/to/checkout   # dev/offline install
  scripts/install-pi.sh --uninstall                      # user-scoped uninstall
  scripts/install-pi.sh --project . --dry-run            # inspect project install
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
    --source-dir)
      [ $# -ge 2 ] || { echo "error: --source-dir requires a path" >&2; usage; exit 2; }
      SOURCE_DIR="$2"
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

if [ -n "$SOURCE_DIR" ]; then
  if [ ! -d "$SOURCE_DIR" ]; then
    echo "error: --source-dir path does not exist: $SOURCE_DIR" >&2
    exit 2
  fi
  SOURCE_DIR="$(cd "$SOURCE_DIR" && pwd)"
fi

SETTINGS_FILE="$([ "$SCOPE" = "user" ] && printf '%s' "$HOME/.pi/agent/settings.json" || printf '%s' "$TARGET_DIR/.pi/settings.json")"
MANIFEST_FILE="$([ "$SCOPE" = "user" ] && printf '%s' "$HOME/.pi/agent/redskills-install-manifest.json" || printf '%s' "$TARGET_DIR/.pi/redskills-install-manifest.json")"

log() { printf 'install-pi: %s\n' "$*"; }
die() { printf 'install-pi: %s\n' "$*" >&2; exit 1; }
warn() { printf 'install-pi: warn: %s\n' "$*" >&2; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required"
}

if [ "$DRY_RUN" != "true" ]; then
  require_cmd pi
  require_cmd jq
fi

# Decide the install source for one plugin: emit the pi install argument and
# the manifest entry to record. npm:<spec> for the npm surface, a filesystem
# path for the local-source surface.
package_spec() {
  local plugin_name="$1"
  if [ -n "$SOURCE_DIR" ]; then
    printf '%s/plugins/%s' "$SOURCE_DIR" "$plugin_name"
    return 0
  fi
  local pin=""
  if [ -n "$PIN_VERSION" ]; then
    pin="@$PIN_VERSION"
  fi
  printf 'npm:%s/red-skills-%s%s' "$NPM_SCOPE" "$plugin_name" "$pin"
}

assert_settings_file_present() {
  [ -f "$SETTINGS_FILE" ] \
    || die "Pi settings file is missing: $SETTINGS_FILE. Run \`pi\` once interactively to create it."
}

read_manifest() {
  [ -f "$MANIFEST_FILE" ] || return 0
  jq -r '.plugins[]? | "\(.name)\t\(.spec)"' "$MANIFEST_FILE"
}

write_manifest() {
  local plugin_name="$1"
  local spec="$2"
  local source_kind="$3"  # "npm" | "local"
  local tmp
  tmp="$(mktemp)"
  if [ -f "$MANIFEST_FILE" ]; then
    jq --arg name "$plugin_name" --arg spec "$spec" --arg kind "$source_kind" \
      '.plugins |= map(select(.name != $name)) + [{name: $name, spec: $spec, source: $kind}]' \
      "$MANIFEST_FILE" > "$tmp"
  else
    mkdir -p "$(dirname "$MANIFEST_FILE")"
    jq -n --arg name "$plugin_name" --arg spec "$spec" --arg kind "$source_kind" \
      '{version: 2, scope: "'"$SCOPE"'", settings_file: "'"$SETTINGS_FILE"'", plugins: [{name: $name, spec: $spec, source: $kind}]}' \
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
  local spec="$2"
  local source_kind="$3"
  if [ "$DRY_RUN" = "true" ]; then
    log "(dry-run) would run: pi install $spec"
    log "(dry-run) manifest entry: $plugin_name -> $spec ($SETTINGS_FILE)"
    return 0
  fi
  log "installing $plugin_name via \`pi install $spec\`"
  if [ "$SCOPE" = "project" ]; then
    ( cd "$TARGET_DIR" && pi install -l "$spec" )
  else
    pi install "$spec"
  fi
  write_manifest "$plugin_name" "$spec" "$source_kind"
}

invoke_pi_remove() {
  local plugin_name="$1"
  local spec="$2"
  if [ "$DRY_RUN" = "true" ]; then
    log "(dry-run) would run: pi remove $spec"
    log "(dry-run) manifest entry: $plugin_name -> $spec"
    return 0
  fi
  log "removing $plugin_name via \`pi remove $spec\`"
  pi remove "$spec" || warn "pi remove reported an error for $plugin_name (continuing)"
  remove_from_manifest "$plugin_name"
}

regenerate_manifests() {
  # The local-source surface needs the plugins/<name>/package.json manifests
  # to exist (they are the package the path-based install resolves through).
  # The npm surface does not — npm carries the staged trees directly. We
  # only regenerate when local-source is in use; CI/npm releases run the
  # generator via `pnpm pi:manifests` separately.
  if [ -z "$SOURCE_DIR" ]; then
    return 0
  fi
  if [ "$DRY_RUN" = "true" ]; then
    log "(dry-run) would run scripts/generate-pi-manifests.mjs"
    return 0
  fi
  if [ ! -f "$SOURCE_DIR/scripts/generate-pi-manifests.mjs" ]; then
    die "scripts/generate-pi-manifests.mjs is missing from $SOURCE_DIR"
  fi
  node "$SOURCE_DIR/scripts/generate-pi-manifests.mjs" --root "$SOURCE_DIR" \
    || die "pi manifest generation failed"
}

run_install() {
  if [ "$DRY_RUN" != "true" ]; then
    assert_settings_file_present
  fi
  regenerate_manifests
  local source_kind="npm"
  if [ -n "$SOURCE_DIR" ]; then
    source_kind="local"
  fi
  for plugin in "${INSTALLED_PLUGINS[@]}"; do
    if [ "$source_kind" = "local" ] && [ ! -d "$SOURCE_DIR/plugins/$plugin" ]; then
      warn "skipping $plugin: source dir $SOURCE_DIR/plugins/$plugin not found"
      continue
    fi
    spec="$(package_spec "$plugin")"
    invoke_pi_install "$plugin" "$spec" "$source_kind"
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
  while IFS=$'\t' read -r plugin_name spec; do
    [ -n "$plugin_name" ] || continue
    invoke_pi_remove "$plugin_name" "$spec"
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