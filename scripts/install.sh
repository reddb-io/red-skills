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
#
# The Claude and Codex marketplaces are registered from the GitHub source
# (reddb-io/red-skills), not from the downloaded snapshot: `plugin marketplace
# update` re-reads whatever source was registered, so a directory registration
# freezes the machine at its install-day version. `--local-marketplace` opts
# into the directory form for offline and dev installs; re-running the installer
# on a machine that already carries a directory registration replaces it.
#
# It also supports --uninstall for the same host set. OpenCode uninstall is
# conservative: manifest-recorded files are removed, generated modules/configs
# are removed when they still match RedSkills output, and unrelated user files
# are kept.

set -euo pipefail

REPO="${RED_SKILLS_REPO:-reddb-io/red-skills}"
VERSION="${RED_SKILLS_VERSION:-latest}"
INSTALL_ROOT="${RED_SKILLS_INSTALL_ROOT:-$HOME/.red-skills}"
ONLY="${RED_SKILLS_ONLY:-auto}"
CLAUDE_SCOPE="${RED_SKILLS_CLAUDE_SCOPE:-user}"
PI_SCOPE="${RED_SKILLS_PI_SCOPE:-user}"
PI_PROJECT_DIR=""
SOURCE_DIR="${RED_SKILLS_SOURCE_DIR:-}"
# Where the host CLIs register the marketplace FROM. `github` is the only shape
# that can ever update: `plugin marketplace update` re-reads the registered
# source, so a `local` registration re-reads the install-day snapshot under
# ~/.red-skills/versions/<tag> forever and freezes the machine at that version.
# `local` stays available for offline and dev installs that want exactly that.
MARKETPLACE_SOURCE="${RED_SKILLS_MARKETPLACE_SOURCE:-github}"
ACTION="${RED_SKILLS_ACTION:-install}"
FORCE="${RED_SKILLS_FORCE:-false}"
PURGE="${RED_SKILLS_PURGE:-false}"
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
  pi       -> per-plugin Pi packages installed via `pi install`, registered in
              ~/.pi/agent/settings.json (or .pi/settings.json with --project)

Options:
  --version <tag>       Install a specific release tag (default: latest release).
                        Pins the downloaded source cache, not the marketplace;
                        combine with --local-marketplace to pin Claude/Codex too.
  --install-root <dir>  Install source cache here (default: ~/.red-skills)
  --only <list>         Comma list: claude,codex,opencode,pi (default: auto-detect)
  --claude-scope <s>    Claude install scope: user, project, or local (default: user)
  --pi-scope <s>        Pi install scope: user or project (default: user)
  --source-dir <dir>    Use an existing red-skills checkout instead of downloading
  --local-marketplace   Register the Claude/Codex marketplace from the local
                        source directory instead of the GitHub source. Offline
                        and dev installs only: a directory-sourced marketplace
                        can never see a release published after install day.
  --uninstall           Remove RedSkills from detected/specified CLIs
  --force               Reinstall plugins where the host supports removal
  --purge               With --uninstall, also remove the RedSkills source cache
  --refresh             Re-download the selected release source
  --opencode-copy       Copy OpenCode SKILL.md files instead of symlinking
  --dry-run             Print actions without writing
  -h, --help            Show this help

Environment:
  RED_SKILLS_VERSION, RED_SKILLS_INSTALL_ROOT, RED_SKILLS_ONLY,
  RED_SKILLS_CLAUDE_SCOPE, RED_SKILLS_PI_SCOPE, RED_SKILLS_SOURCE_DIR,
  RED_SKILLS_ACTION, RED_SKILLS_FORCE, RED_SKILLS_PURGE, RED_SKILLS_REFRESH,
  RED_SKILLS_OPENCODE_COPY, RED_SKILLS_MARKETPLACE_SOURCE (github|local),
  RED_SKILLS_REPO, GITHUB_TOKEN.
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

has_uninstall_target() {
  local target="$1"
  if [[ "$ONLY" != "auto" ]]; then
    has_target "$target"
    return
  fi

  case "$target" in
    opencode)
      command -v opencode >/dev/null 2>&1 && return 0
      [[ -d "${XDG_CONFIG_HOME:-$HOME/.config}/opencode" ]] && return 0
      return 1
      ;;
    pi)
      command -v pi >/dev/null 2>&1 && return 0
      [[ -d "$HOME/.pi/agent" ]] && return 0
      return 1
      ;;
    *)
      command -v "$target" >/dev/null 2>&1
      ;;
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

  mkdir -p "$source/dist"
  if [[ "$REFRESH" == "true" || ! -f "$out" ]]; then
    if curl_file "$url" "$out.tmp"; then
      mv "$out.tmp" "$out"
      log "downloaded optional release asset $asset"
    else
      rm -f "$out.tmp"
      warn "optional release asset $asset is unavailable for $tag; OpenCode install may build from source"
    fi
  fi

  local generated_asset="opencode-host.generated.tgz"
  local generated_out="$source/dist/$generated_asset"
  local generated_url="https://github.com/$REPO/releases/download/$tag/$generated_asset"
  if [[ "$REFRESH" == "true" || ! -f "$source/dist/opencode/.release-generated" ]]; then
    if curl_file "$generated_url" "$generated_out.tmp"; then
      mv "$generated_out.tmp" "$generated_out"
      tar -xzf "$generated_out" -C "$source"
      log "downloaded optional release asset $generated_asset"
    else
      rm -f "$generated_out.tmp"
      warn "optional release asset $generated_asset is unavailable for $tag; OpenCode install may generate from source"
    fi
  fi

  local rsp_asset rsp_out rsp_url
  mkdir -p "$source/packaging/npm/dist"
  for rsp_asset in rsp.bundle.min.mjs rsp-core.bundle.min.mjs; do
    rsp_out="$source/packaging/npm/dist/$rsp_asset"
    rsp_url="https://github.com/$REPO/releases/download/$tag/$rsp_asset"
    if [[ "$REFRESH" == "true" || ! -f "$rsp_out" ]]; then
      if curl_file "$rsp_url" "$rsp_out.tmp"; then
        mv "$rsp_out.tmp" "$rsp_out"
        log "downloaded optional release asset $rsp_asset"
      else
        rm -f "$rsp_out.tmp"
        warn "optional release asset $rsp_asset is unavailable for $tag; RSP may build from source"
      fi
    fi
  done
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
    # Extracted twice on purpose, and only the second failure counts.
    # The archive carries an AGENTS.md -> CLAUDE.md symlink, and Git
    # Bash's tar emulates symlink() as a copy of the target — which
    # fails on the first pass when the link precedes its target in
    # archive order, and succeeds on the second because by then the
    # target exists on disk. Unix extracts clean on the first pass and
    # never reaches the retry.
    tar -xzf "$archive" -C "$tmp" 2>/dev/null || tar -xzf "$archive" -C "$tmp"
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

  download_release_asset_if_available "$tag" "$dest"
  rm -f "$current"
  ln -s "$dest" "$current"
  SOURCE_DIR="$current"
  log "current source -> $dest"
}

# The reference a host CLI registers the marketplace from. The GitHub source is
# what makes `plugin marketplace update` pull origin and see future releases;
# the local source dir is the frozen-snapshot fallback.
marketplace_ref() {
  if [[ "$MARKETPLACE_SOURCE" == "local" ]]; then
    printf '%s\n' "$SOURCE_DIR"
  else
    printf '%s\n' "$REPO"
  fi
}

# The source kind this install wants, in the vocabulary the host CLIs print.
desired_marketplace_kind() {
  if [[ "$MARKETPLACE_SOURCE" == "local" ]]; then
    printf 'directory\n'
  else
    printf 'github\n'
  fi
}

# Read one marketplace's registered source kind from a `plugin marketplace list`
# transcript on stdin. The rendered shape is an entry line followed by an
# indented `Source: <Kind> (<detail>)` line:
#
#   Configured marketplaces:
#
#     ❯ red-skills
#       Source: Directory (/home/…/.red-skills/current)
#
# Prints the lowercased kind (`github`, `directory`, `git`), `absent` when the
# marketplace is not registered, or `unknown` when a source line cannot be read.
marketplace_source_kind() {
  local name="$1"
  awk -v name="$name" '
    {
      line = $0
      sub(/^[[:space:]]*[^[:alnum:]_.\/-]*[[:space:]]*/, "", line)
      sub(/[[:space:]]+$/, "", line)
      if (line == "") next
      if (line ~ /^Source:/) {
        if (!found) next
        kind = line
        sub(/^Source:[[:space:]]*/, "", kind)
        sub(/[^[:alnum:]].*$/, "", kind)
        print tolower(kind)
        printed = 1
        exit
      }
      found = (line == name)
    }
    END { if (!printed) print (found ? "unknown" : "absent") }
  '
}

# What the host CLI currently has registered for red-skills. A CLI that cannot
# answer reports `unknown`, which never triggers a re-registration: replacing a
# registration we could not read would discard whatever the operator configured.
host_marketplace_kind() {
  local cli="$1" listed
  if ! listed="$("$cli" plugin marketplace list 2>/dev/null)"; then
    printf 'unknown\n'
    return 0
  fi
  printf '%s\n' "$listed" | marketplace_source_kind red-skills
}

# Heal a registration whose source cannot reach future releases. A machine
# installed before this change carries a Directory source, so `marketplace
# update` re-reads its install-day snapshot forever; re-running the installer
# removes that registration and re-adds it from the GitHub source.
heal_marketplace_source() {
  local cli="$1" current desired
  desired="$(desired_marketplace_kind)"
  current="$(host_marketplace_kind "$cli")"
  case "$current" in
    absent|unknown|"$desired") return 0 ;;
  esac
  warn "$cli red-skills marketplace is $current-sourced but this install wants $desired; re-registering from $(marketplace_ref)"
  try_run "$cli" plugin marketplace remove red-skills || true
}

install_claude() {
  if ! command -v claude >/dev/null 2>&1; then
    warn "claude not found; skipping Claude Code"
    return 0
  fi

  local ref
  ref="$(marketplace_ref)"
  log "installing Claude Code marketplace/plugins from $ref"
  heal_marketplace_source claude
  if ! try_run claude plugin marketplace add --scope "$CLAUDE_SCOPE" "$ref"; then
    warn "Claude marketplace add failed; replacing existing red-skills marketplace source"
    try_run claude plugin marketplace remove red-skills || true
    try_run claude plugin marketplace add --scope "$CLAUDE_SCOPE" "$ref" || die "Claude marketplace add failed"
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

  local ref
  ref="$(marketplace_ref)"
  log "installing Codex marketplace/plugins from $ref"
  heal_marketplace_source codex
  if ! try_run codex plugin marketplace add "$ref"; then
    warn "Codex marketplace add failed; replacing existing red-skills marketplace source"
    try_run codex plugin marketplace remove red-skills || true
    try_run codex plugin marketplace add "$ref" || die "Codex marketplace add failed"
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

install_pi() {
  if ! command -v pi >/dev/null 2>&1; then
    warn "pi not found; skipping Pi"
    return 0
  fi

  if [[ "$DRY_RUN" != "true" ]]; then
    [[ -x "$SOURCE_DIR/scripts/install-pi.sh" ]] || die "source is missing executable scripts/install-pi.sh"
    require_cmd node
  fi

  local args=("$SOURCE_DIR/scripts/install-pi.sh")
  # The universal installer always installs from the local release checkout
  # (SOURCE_DIR is the cached tarball under ~/.red-skills/versions/<tag>),
  # which keeps paths stable across re-runs of the same release. End users
  # who want the npm surface run `pi install npm:@reddb-io/red-skills-<plugin>`
  # directly; this script gives them the version-pinned cache instead.
  args+=("--source-dir" "$SOURCE_DIR")
  if [[ "$PI_SCOPE" == "project" ]]; then
    args+=("--project" "${PI_PROJECT_DIR:-$PWD}")
  else
    args+=("--user")
  fi
  log "installing Pi packages from $SOURCE_DIR ($PI_SCOPE scope, source-dir)"
  run "${args[@]}"
}

remove_generated_config() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  if head -n 1 "$file" | grep -Fq 'generated by @reddb-io/red-skills'; then
    run rm -f "$file"
  else
    log "(note) kept $file because it is not a RedSkills-generated config"
  fi
}

write_expected_tui() {
  local out="$1"
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
  local file="$1"
  [[ -f "$file" ]] || return 0
  local tmp
  tmp="$(mktemp)"
  write_expected_tui "$tmp"
  if cmp -s "$file" "$tmp"; then
    rm -f "$tmp"
    run rm -f "$file"
  else
    rm -f "$tmp"
    log "(note) kept $file because it no longer exactly matches the RedSkills TUI template"
  fi
}

opencode_source_dir_for_matching() {
  if [[ -n "$SOURCE_DIR" && -d "$SOURCE_DIR/plugins" ]]; then
    printf '%s\n' "$SOURCE_DIR"
    return 0
  fi
  if [[ -d "$INSTALL_ROOT/current/plugins" ]]; then
    printf '%s\n' "$INSTALL_ROOT/current"
    return 0
  fi
  return 1
}

remove_matching_opencode_skills() {
  local target_skills_dir="$1"
  local source="$2"
  [[ -d "$target_skills_dir" && -d "$source/plugins" ]] || return 0

  local ordered_plugins="" preferred plugin_dir plugin source_skill skill_name target_skill
  for preferred in dev memory brain; do
    [[ -d "$source/plugins/$preferred" ]] && ordered_plugins="$ordered_plugins $preferred"
  done
  for plugin_dir in "$source"/plugins/*; do
    [[ -d "$plugin_dir" ]] || continue
    plugin="$(basename "$plugin_dir")"
    case " $ordered_plugins " in
      *" $plugin "*) ;;
      *) ordered_plugins="$ordered_plugins $plugin" ;;
    esac
  done

  for plugin in $ordered_plugins; do
    [[ -d "$source/plugins/$plugin/skills" ]] || continue
    while IFS= read -r source_skill; do
      skill_name="$(basename "$(dirname "$source_skill")")"
      target_skill="$target_skills_dir/$skill_name/SKILL.md"
      if [[ -e "$target_skill" ]] && cmp -s "$target_skill" "$source_skill"; then
        run rm -rf "$target_skills_dir/$skill_name"
      fi
    done < <(find "$source/plugins/$plugin/skills" -name SKILL.md -type f | sort)
  done
}

uninstall_claude() {
  if ! command -v claude >/dev/null 2>&1; then
    warn "claude not found; skipping Claude Code uninstall"
    return 0
  fi

  log "uninstalling Claude Code RedSkills plugins/marketplace"
  local plugin
  local -a remove_args
  for plugin in brain memory dev; do
    remove_args=(claude plugin remove --scope "$CLAUDE_SCOPE")
    [[ "$PURGE" == "true" ]] || remove_args+=(--keep-data)
    remove_args+=("$plugin")
    try_run "${remove_args[@]}" || true
  done
  try_run claude plugin marketplace remove red-skills || true
}

uninstall_codex() {
  if ! command -v codex >/dev/null 2>&1; then
    warn "codex not found; skipping Codex CLI uninstall"
    return 0
  fi

  log "uninstalling Codex RedSkills plugins/marketplace"
  local plugin
  for plugin in brain memory dev; do
    try_run codex plugin remove "$plugin@red-skills" || true
  done
  try_run codex plugin marketplace remove red-skills || true
}

opencode_source_dir_for_uninstall() {
  if [[ -n "$SOURCE_DIR" && -x "$SOURCE_DIR/scripts/install-opencode.sh" ]] \
    && grep -Fq -- '--uninstall' "$SOURCE_DIR/scripts/install-opencode.sh"; then
    printf '%s\n' "$SOURCE_DIR"
    return 0
  fi
  if [[ -x "$INSTALL_ROOT/current/scripts/install-opencode.sh" ]] \
    && grep -Fq -- '--uninstall' "$INSTALL_ROOT/current/scripts/install-opencode.sh"; then
    printf '%s\n' "$INSTALL_ROOT/current"
    return 0
  fi
  return 1
}

uninstall_pi() {
  local manifest_user="$HOME/.pi/agent/redskills-install-manifest.json"
  local manifest_project=""
  if [[ -n "$PI_PROJECT_DIR" ]]; then
    manifest_project="$(cd "$PI_PROJECT_DIR" 2>/dev/null && pwd)/.pi/redskills-install-manifest.json"
  fi

  if ! command -v pi >/dev/null 2>&1; then
    warn "pi not found; skipping Pi uninstall"
    if [[ -f "$manifest_user" ]]; then
      rm -f "$manifest_user"
      log "removed stale manifest $manifest_user"
    fi
    return 0
  fi

  local source
  if source="$(opencode_source_dir_for_uninstall)"; then
    log "uninstalling Pi RedSkills packages via $source/scripts/install-pi.sh"
    if [[ -f "$manifest_user" ]]; then
      run "$source/scripts/install-pi.sh" --uninstall --user
    fi
    if [[ -n "$manifest_project" && -f "$manifest_project" ]]; then
      ( cd "$PI_PROJECT_DIR" && run "$source/scripts/install-pi.sh" --uninstall --project "$PI_PROJECT_DIR" )
    fi
    return 0
  fi

  warn "no RedSkills source checkout found; skipped Pi uninstall"
}

uninstall_opencode() {
  local source
  if source="$(opencode_source_dir_for_uninstall)"; then
    log "uninstalling OpenCode RedSkills files via $source/scripts/install-opencode.sh"
    run "$source/scripts/install-opencode.sh" --uninstall --global
    return 0
  fi

  local xdg_root="${XDG_CONFIG_HOME:-$HOME/.config}"
  local opencode_root="$xdg_root/opencode"
  local plugins_dir="$opencode_root/plugins"
  local skills_dir="$opencode_root/skills"
  log "uninstalling OpenCode RedSkills files from $opencode_root"

  local file
  for file in "$plugins_dir"/redskills-*.ts; do
    [[ -e "$file" ]] || continue
    run rm -f "$file"
  done

  local manifest="$opencode_root/redskills-install-manifest.txt"
  if [[ -f "$manifest" ]]; then
    while IFS= read -r path || [[ -n "$path" ]]; do
      case "$path" in
        ""|\#*) continue ;;
        "$opencode_root"/*) run rm -rf "$path" ;;
        *) warn "skipped manifest path outside $opencode_root: $path" ;;
      esac
    done < "$manifest"
    run rm -f "$manifest"
  fi

  local matching_source
  if matching_source="$(opencode_source_dir_for_matching)"; then
    remove_matching_opencode_skills "$skills_dir" "$matching_source"
  else
    warn "no RedSkills source checkout found; skipped OpenCode skill comparison cleanup"
  fi

  remove_generated_config "$opencode_root/opencode.json"
  remove_generated_config "$opencode_root/opencode.jsonc"
  remove_redskills_tui "$opencode_root/tui.json"
  remove_redskills_tui "$opencode_root/tui.jsonc"
}

run_uninstall() {
  local touched_any="false"
  if has_uninstall_target claude; then
    uninstall_claude
    touched_any="true"
  fi
  if has_uninstall_target codex; then
    uninstall_codex
    touched_any="true"
  fi
  if has_uninstall_target opencode; then
    uninstall_opencode
    touched_any="true"
  fi
  if has_uninstall_target pi; then
    uninstall_pi
    touched_any="true"
  fi

  if [[ "$PURGE" == "true" ]]; then
    run rm -rf "$INSTALL_ROOT"
  fi

  if [[ "$touched_any" != "true" ]]; then
    warn "no supported CLIs/configs detected (claude, codex, opencode, pi)"
  fi
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
    --pi-scope)
      [[ $# -ge 2 ]] || die "$1 requires a value"
      PI_SCOPE="$2"
      shift 2
      ;;
    --pi-project-dir)
      [[ $# -ge 2 ]] || die "$1 requires a value"
      PI_PROJECT_DIR="$2"
      PI_SCOPE="project"
      shift 2
      ;;
    --source-dir)
      [[ $# -ge 2 ]] || die "$1 requires a value"
      SOURCE_DIR="$2"
      shift 2
      ;;
    --local-marketplace)
      MARKETPLACE_SOURCE="local"
      shift
      ;;
    --marketplace-source)
      [[ $# -ge 2 ]] || die "$1 requires a value"
      MARKETPLACE_SOURCE="$2"
      shift 2
      ;;
    --uninstall)
      ACTION="uninstall"
      shift
      ;;
    --force)
      FORCE="true"
      shift
      ;;
    --purge)
      PURGE="true"
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

case "$PI_SCOPE" in
  user|project) ;;
  *) die "--pi-scope must be user or project" ;;
esac

case "$MARKETPLACE_SOURCE" in
  github|local) ;;
  *) die "--marketplace-source must be github or local" ;;
esac

case "$ACTION" in
  install|uninstall) ;;
  *) die "RED_SKILLS_ACTION must be install or uninstall" ;;
esac

case "$ONLY" in
  auto) ;;
  *)
    IFS=',' read -r -a requested_targets <<<"$ONLY"
    for target in "${requested_targets[@]}"; do
      case "$target" in
        claude|codex|opencode|pi) ;;
        *) die "--only contains unsupported target '$target'" ;;
      esac
    done
    ;;
esac

if [[ "$ACTION" == "uninstall" ]]; then
  run_uninstall
  log "done"
  log "restart open CLI sessions so they drop unloaded RedSkills plugins"
  exit 0
fi

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
if has_target pi; then
  install_pi
  installed_any="true"
fi

if [[ "$installed_any" != "true" ]]; then
  warn "no supported CLIs detected (claude, codex, opencode, pi)"
fi

log "done"
log "restart open CLI sessions so they reload plugin manifests"
log "inside each repo, run /red-setup (Claude/OpenCode) or \$dev:red-setup (Codex when namespace-qualified)"
