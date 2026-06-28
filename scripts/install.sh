#!/usr/bin/env bash
# Universal RedSkills installer.
#
# Intended curl entrypoint:
#   curl -fsSL https://raw.githubusercontent.com/reddb-io/red-skills/v1/scripts/install.sh | bash
#
# The script resolves the latest GitHub Release by default, installs that source
# tree under ~/.red-skills, detects supported local CLIs, then wires each host:
#   - Claude Code: marketplace + plugins
#   - Codex CLI: marketplace + plugins
#   - OpenCode: generated plugin/skill/MCP/statusline surface

set -euo pipefail

REPO="${RED_SKILLS_REPO:-reddb-io/red-skills}"
VERSION="${RED_SKILLS_VERSION:-latest}"
INSTALL_ROOT="${RED_SKILLS_INSTALL_ROOT:-$HOME/.red-skills}"
ONLY="${RED_SKILLS_ONLY:-auto}"
CLAUDE_SCOPE="${RED_SKILLS_CLAUDE_SCOPE:-user}"
SOURCE_DIR="${RED_SKILLS_SOURCE_DIR:-}"
FORCE="${RED_SKILLS_FORCE:-false}"
REFRESH="${RED_SKILLS_REFRESH:-false}"
DRY_RUN="false"
OPENCODE_COPY="${RED_SKILLS_OPENCODE_COPY:-false}"

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Installs RedSkills into every detected supported CLI:
  claude   -> Claude Code marketplace + dev/memory/brain plugins
  codex    -> Codex marketplace + dev/memory/brain plugins
  opencode -> generated OpenCode plugins, skills, MCP config, and TUI config

Options:
  --version <tag>       Install a specific release tag (default: latest release)
  --install-root <dir>  Install source cache here (default: ~/.red-skills)
  --only <list>         Comma list: claude,codex,opencode (default: auto-detect)
  --claude-scope <s>    Claude install scope: user, project, or local (default: user)
  --source-dir <dir>    Use an existing red-skills checkout instead of downloading
  --force               Reinstall plugins where the host supports removal
  --refresh             Re-download the selected release source
  --opencode-copy       Copy OpenCode SKILL.md files instead of symlinking
  --dry-run             Print actions without writing
  -h, --help            Show this help

Environment:
  RED_SKILLS_VERSION, RED_SKILLS_INSTALL_ROOT, RED_SKILLS_ONLY,
  RED_SKILLS_CLAUDE_SCOPE, RED_SKILLS_SOURCE_DIR, RED_SKILLS_FORCE,
  RED_SKILLS_REFRESH, RED_SKILLS_OPENCODE_COPY, GITHUB_TOKEN.
EOF
}

log() { printf 'red-skills install: %s\n' "$*"; }
warn() { printf 'red-skills install: warn: %s\n' "$*" >&2; }
die() {
  printf 'red-skills install: error: %s\n' "$*" >&2
  exit 1
}

quote_cmd() {
  local out="" arg
  for arg in "$@"; do
    printf -v arg '%q' "$arg"
    out="$out $arg"
  done
  printf '%s' "$out"
}

run() {
  log "+$(quote_cmd "$@")"
  if [[ "$DRY_RUN" == "true" ]]; then
    return 0
  fi
  "$@"
}

try_run() {
  log "+$(quote_cmd "$@")"
  if [[ "$DRY_RUN" == "true" ]]; then
    return 0
  fi
  "$@"
}

has_target() {
  local target="$1"
  if [[ "$ONLY" == "auto" ]]; then
    command -v "$target" >/dev/null 2>&1
    return
  fi
  case ",$ONLY," in
    *,"$target",*) return 0 ;;
    *) return 1 ;;
  esac
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required"
}

curl_json() {
  local url="$1"
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" "$url"
  else
    curl -fsSL "$url"
  fi
}

curl_file() {
  local url="$1"
  local out="$2"
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" "$url" -o "$out"
  else
    curl -fsSL "$url" -o "$out"
  fi
}

latest_release_tag() {
  local api="https://api.github.com/repos/$REPO/releases/latest"
  local tag
  tag="$(curl_json "$api" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
  [[ -n "$tag" ]] || die "could not resolve latest release from $api"
  printf '%s\n' "$tag"
}

safe_release_tag() {
  local tag="$1"
  case "$tag" in
    v[0-9]*.[0-9]*.[0-9]* | [0-9]*.[0-9]*.[0-9]*) printf '%s\n' "$tag" ;;
    *) die "release tag must look like vX.Y.Z, got '$tag'" ;;
  esac
}

download_release_asset_if_available() {
  local tag="$1"
  local source="$2"
  local asset="opencode-host.bundle.min.mjs"
  local out="$source/dist/$asset"
  local url="https://github.com/$REPO/releases/download/$tag/$asset"

  if [[ "$DRY_RUN" == "true" ]]; then
    log "would download optional release asset $url"
    return 0
  fi

  [[ "$REFRESH" == "true" || ! -f "$out" ]] || return 0
  mkdir -p "$source/dist"
  if curl_file "$url" "$out.tmp"; then
    mv "$out.tmp" "$out"
    log "downloaded optional release asset $asset"
  else
    rm -f "$out.tmp"
    warn "optional release asset $asset is unavailable for $tag; OpenCode install may build from source"
  fi
}

prepare_source() {
  if [[ -n "$SOURCE_DIR" ]]; then
    [[ -d "$SOURCE_DIR" ]] || die "--source-dir does not exist: $SOURCE_DIR"
    SOURCE_DIR="$(cd "$SOURCE_DIR" && pwd)"
    [[ -f "$SOURCE_DIR/.claude-plugin/marketplace.json" ]] || die "source dir is missing .claude-plugin/marketplace.json"
    [[ -f "$SOURCE_DIR/.agents/plugins/marketplace.json" ]] || die "source dir is missing .agents/plugins/marketplace.json"
    log "using local source: $SOURCE_DIR"
    return 0
  fi

  require_cmd curl
  require_cmd tar
  require_cmd mktemp

  local tag="$VERSION"
  if [[ "$tag" == "latest" ]]; then
    tag="$(latest_release_tag)"
  fi
  tag="$(safe_release_tag "$tag")"
  VERSION="$tag"

  local versions_dir="$INSTALL_ROOT/versions"
  local cache_dir="$INSTALL_ROOT/cache"
  local dest="$versions_dir/$tag"
  local current="$INSTALL_ROOT/current"
  local archive="$cache_dir/$tag.tar.gz"

  if [[ "$DRY_RUN" == "true" ]]; then
    log "would install $REPO@$tag under $dest"
    SOURCE_DIR="$current"
    return 0
  fi

  mkdir -p "$versions_dir" "$cache_dir"
  if [[ "$REFRESH" == "true" ]]; then
    rm -rf "$dest" "$archive"
  fi

  if [[ ! -d "$dest" ]]; then
    local url="https://github.com/$REPO/archive/refs/tags/$tag.tar.gz"
    local tmp extracted
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' RETURN
    log "downloading $url"
    curl -fsSL "$url" -o "$archive"
    tar -xzf "$archive" -C "$tmp"
    extracted="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
    [[ -n "$extracted" ]] || die "archive did not contain a source directory"
    rm -rf "$dest.tmp"
    mv "$extracted" "$dest.tmp"
    mv "$dest.tmp" "$dest"
    rm -rf "$tmp"
    trap - RETURN
  else
    log "using cached source $dest"
  fi

  rm -f "$current"
  ln -s "$dest" "$current"
  download_release_asset_if_available "$tag" "$dest"
  SOURCE_DIR="$current"
  log "current source -> $dest"
}

install_claude() {
  if ! command -v claude >/dev/null 2>&1; then
    warn "claude not found; skipping Claude Code"
    return 0
  fi

  log "installing Claude Code marketplace/plugins from $SOURCE_DIR"
  if ! try_run claude plugin marketplace add --scope "$CLAUDE_SCOPE" "$SOURCE_DIR"; then
    warn "Claude marketplace add failed; replacing existing red-skills marketplace source"
    try_run claude plugin marketplace remove red-skills || true
    try_run claude plugin marketplace add --scope "$CLAUDE_SCOPE" "$SOURCE_DIR" || die "Claude marketplace add failed"
  fi
  try_run claude plugin marketplace update red-skills || warn "Claude marketplace update failed; continuing"

  local plugin
  for plugin in dev memory brain; do
    if [[ "$FORCE" == "true" ]]; then
      try_run claude plugin remove --scope "$CLAUDE_SCOPE" --keep-data "$plugin" || true
    fi
    if ! try_run claude plugin install --scope "$CLAUDE_SCOPE" "$plugin@red-skills"; then
      warn "Claude install for $plugin failed; trying update"
      try_run claude plugin update --scope "$CLAUDE_SCOPE" "$plugin" || die "Claude plugin $plugin install/update failed"
    fi
  done
}

install_codex() {
  if ! command -v codex >/dev/null 2>&1; then
    warn "codex not found; skipping Codex CLI"
    return 0
  fi

  log "installing Codex marketplace/plugins from $SOURCE_DIR"
  if ! try_run codex plugin marketplace add "$SOURCE_DIR"; then
    warn "Codex marketplace add failed; replacing existing red-skills marketplace source"
    try_run codex plugin marketplace remove red-skills || true
    try_run codex plugin marketplace add "$SOURCE_DIR" || die "Codex marketplace add failed"
  fi
  try_run codex plugin marketplace upgrade red-skills || warn "Codex marketplace upgrade failed; continuing"

  local plugin
  for plugin in dev memory brain; do
    # Codex currently has marketplace upgrade but no plugin update command.
    # Remove/re-add to make a rerun converge on the selected release source.
    try_run codex plugin remove "$plugin@red-skills" || true
    if ! try_run codex plugin add "$plugin@red-skills"; then
      die "Codex plugin $plugin install failed"
    fi
  done
}

install_opencode() {
  if ! command -v opencode >/dev/null 2>&1; then
    warn "opencode not found; skipping OpenCode"
    return 0
  fi

  if [[ "$DRY_RUN" != "true" ]]; then
    [[ -x "$SOURCE_DIR/scripts/install-opencode.sh" ]] || die "source is missing executable scripts/install-opencode.sh"
    require_cmd node
    if [[ ! -f "$SOURCE_DIR/dist/opencode-host.bundle.min.mjs" ]]; then
      require_cmd pnpm
    fi
  fi

  local args=("$SOURCE_DIR/scripts/install-opencode.sh" "--global")
  [[ "$OPENCODE_COPY" == "true" ]] && args+=("--copy")
  log "installing OpenCode generated plugin surface from $SOURCE_DIR"
  run "${args[@]}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version|--ref)
      [[ $# -ge 2 ]] || die "$1 requires a value"
      VERSION="$2"
      shift 2
      ;;
    --install-root)
      [[ $# -ge 2 ]] || die "$1 requires a value"
      INSTALL_ROOT="$2"
      shift 2
      ;;
    --only)
      [[ $# -ge 2 ]] || die "$1 requires a value"
      ONLY="$2"
      shift 2
      ;;
    --claude-scope)
      [[ $# -ge 2 ]] || die "$1 requires a value"
      CLAUDE_SCOPE="$2"
      shift 2
      ;;
    --source-dir)
      [[ $# -ge 2 ]] || die "$1 requires a value"
      SOURCE_DIR="$2"
      shift 2
      ;;
    --force)
      FORCE="true"
      shift
      ;;
    --refresh)
      REFRESH="true"
      shift
      ;;
    --opencode-copy)
      OPENCODE_COPY="true"
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
      die "unknown argument: $1"
      ;;
  esac
done

case "$CLAUDE_SCOPE" in
  user|project|local) ;;
  *) die "--claude-scope must be user, project, or local" ;;
esac

case "$ONLY" in
  auto) ;;
  *)
    IFS=',' read -r -a requested_targets <<<"$ONLY"
    for target in "${requested_targets[@]}"; do
      case "$target" in
        claude|codex|opencode) ;;
        *) die "--only contains unsupported target '$target'" ;;
      esac
    done
    ;;
esac

prepare_source

installed_any="false"
if has_target claude; then
  install_claude
  installed_any="true"
fi
if has_target codex; then
  install_codex
  installed_any="true"
fi
if has_target opencode; then
  install_opencode
  installed_any="true"
fi

if [[ "$installed_any" != "true" ]]; then
  warn "no supported CLIs detected (claude, codex, opencode)"
fi

log "done"
log "restart open CLI sessions so they reload plugin manifests"
log "inside each repo, run /setup-red-skills (Claude/OpenCode) or \$dev:setup-red-skills (Codex when namespace-qualified)"
