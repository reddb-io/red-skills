#!/usr/bin/env bash
# Universal RedSkills installer.
#
# Intended curl entrypoint:
#   curl -fsSL https://raw.githubusercontent.com/reddb-io/red-skills/v1/scripts/install.sh | bash
#
# The script resolves the published npm packages by default, materialises their
# runtime tree under ~/.red-skills, detects supported local CLIs, then wires each host:
#   - Claude Code: marketplace + plugins
#   - Codex CLI: marketplace + plugins
#   - Gemini CLI: self-contained dev extension from the local package set
#   - Hermes: complete dev skills in its user-global skills directory
#   - OpenCode/RedCode: generated plugin/skill/MCP/statusline surface
#
# The Claude and Codex marketplaces are registered from the GitHub source
# (reddb-io/red-skills), not from the materialised tree: `plugin marketplace
# update` re-reads whatever source was registered, so a directory registration
# freezes the machine at its install-day version. `--local-marketplace` opts
# into the directory form for offline and dev installs; re-running the installer
# on a machine that already carries a directory registration replaces it.
#
# It also supports --uninstall for the same host set. OpenCode-compatible uninstall is
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
  gemini   -> generated, self-contained dev extension from the local package set
  hermes   -> complete dev skills in $HERMES_HOME/skills (default: ~/.hermes/skills)
  opencode -> generated OpenCode plugins, skills, MCP config, and TUI config
  redcode  -> generated RedCode plugins, skills, MCP config, and TUI config
  pi       -> per-plugin Pi packages installed via `pi install`, registered in
              ~/.pi/agent/settings.json (or .pi/settings.json with --project)

Options:
  --version <tag>       Install a specific release tag (default: latest release).
                        Pins the materialised npm packages, not the marketplace;
                        combine with --local-marketplace to pin Claude/Codex too.
  --install-root <dir>  Install versioned runtime trees here (default: ~/.red-skills)
  --only <list>         Comma list: claude,codex,gemini,hermes,opencode,redcode,pi (default: auto-detect)
  --claude-scope <s>    Claude install scope: user, project, or local (default: user)
  --pi-scope <s>        Pi install scope: user or project (default: user)
  --source-dir <dir>    Use an existing red-skills checkout instead of npm packages
  --local-marketplace   Register the Claude/Codex marketplace from the local
                        source directory instead of the GitHub source. Offline
                        and dev installs only: a directory-sourced marketplace
                        can never see a release published after install day.
  --uninstall           Remove RedSkills from detected/specified CLIs
  --force               Reinstall plugins where the host supports removal
  --purge               With --uninstall, also remove the RedSkills install tree
  --refresh             Re-materialise the selected npm packages
  --opencode-copy       Copy OpenCode-compatible SKILL.md files instead of symlinking
  --dry-run             Print actions without writing
  -h, --help            Show this help

Environment:
  RED_SKILLS_VERSION, RED_SKILLS_INSTALL_ROOT, RED_SKILLS_ONLY,
  RED_SKILLS_CLAUDE_SCOPE, RED_SKILLS_PI_SCOPE, RED_SKILLS_SOURCE_DIR,
  RED_SKILLS_ACTION, RED_SKILLS_FORCE, RED_SKILLS_PURGE, RED_SKILLS_REFRESH,
  RED_SKILLS_OPENCODE_COPY, RED_SKILLS_MARKETPLACE_SOURCE (github|local),
  RED_SKILLS_REPO.
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
    opencode|redcode)
      command -v "$target" >/dev/null 2>&1 && return 0
      [[ -d "${XDG_CONFIG_HOME:-$HOME/.config}/$target" ]] && return 0
      return 1
      ;;
    pi)
      command -v pi >/dev/null 2>&1 && return 0
      [[ -d "$HOME/.pi/agent" ]] && return 0
      return 1
      ;;
    hermes)
      command -v hermes >/dev/null 2>&1 && return 0
      [[ -f "${HERMES_HOME:-$HOME/.hermes}/redskills-dev-owned.txt" ]] && return 0
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

safe_release_tag() {
  local tag="$1"
  case "$tag" in
    v[0-9]*.[0-9]*.[0-9]* | [0-9]*.[0-9]*.[0-9]*) printf '%s\n' "$tag" ;;
    *) die "release tag must look like vX.Y.Z, got '$tag'" ;;
  esac
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

  require_cmd mktemp

  local tag="$VERSION"
  local versions_dir="$INSTALL_ROOT/versions"
  local current="$INSTALL_ROOT/current"
  local npm_version="$tag"
  if [[ "$tag" != "latest" ]]; then
    tag="$(safe_release_tag "$tag")"
    npm_version="${tag#v}"
  fi

  if [[ "$DRY_RUN" == "true" ]]; then
    log "would materialise @reddb-io/red-skills@$npm_version and plugin packages under $versions_dir/$tag"
    SOURCE_DIR="$current"
    return 0
  fi

  mkdir -p "$versions_dir"

  local tmp core package_dir package_version plugin bundle resolved_version dest
  local -a plugins=(dev memory brain internal)
  local -a specs=("@reddb-io/red-skills@$npm_version")
  for plugin in "${plugins[@]}"; do
    specs+=("@reddb-io/red-skills-$plugin@$npm_version")
  done

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  log "materialising ${specs[*]}"
  npm install "${specs[@]}" --prefix "$tmp" \
    --no-save --no-audit --no-fund --ignore-scripts --loglevel=error

  core="$tmp/node_modules/@reddb-io/red-skills"
  [[ -f "$core/package.json" ]] || die "npm did not materialise @reddb-io/red-skills"
  resolved_version="$(node -e 'process.stdout.write(require(process.argv[1]).version || "")' "$core/package.json")"
  [[ -n "$resolved_version" ]] || die "@reddb-io/red-skills package has no version"
  if [[ "$VERSION" == "latest" ]]; then
    tag="v$resolved_version"
  elif [[ "$resolved_version" != "$npm_version" ]]; then
    die "npm resolved @reddb-io/red-skills@$resolved_version, expected $npm_version"
  fi
  VERSION="$tag"
  dest="$versions_dir/$tag"

  for plugin in "${plugins[@]}"; do
    package_dir="$tmp/node_modules/@reddb-io/red-skills-$plugin"
    bundle="$package_dir/dist/$plugin.bundle.min.mjs"
    [[ -f "$package_dir/package.json" ]] || die "npm did not materialise @reddb-io/red-skills-$plugin"
    [[ -f "$bundle" ]] || die "@reddb-io/red-skills-$plugin package is missing dist/$plugin.bundle.min.mjs"
    package_version="$(node -e 'process.stdout.write(require(process.argv[1]).version || "")' "$package_dir/package.json")"
    [[ "$package_version" == "$resolved_version" ]] \
      || die "npm resolved @reddb-io/red-skills-$plugin@$package_version, expected $resolved_version"
  done

  if [[ "$REFRESH" == "true" ]]; then
    rm -rf "$dest"
  fi
  if [[ ! -d "$dest" ]]; then
    rm -rf "$dest.tmp"
    mkdir -p "$dest.tmp/plugins" "$dest.tmp/dist"
    cp -R "$core/." "$dest.tmp/"
    for plugin in "${plugins[@]}"; do
      package_dir="$tmp/node_modules/@reddb-io/red-skills-$plugin"
      bundle="$package_dir/dist/$plugin.bundle.min.mjs"
      cp -R "$package_dir" "$dest.tmp/plugins/$plugin"
      cp "$bundle" "$dest.tmp/dist/$plugin.bundle.min.mjs"
    done
    mv "$dest.tmp" "$dest"
  else
    log "using cached npm materialisation $dest"
  fi

  rm -rf "$tmp"
  trap - RETURN
  rm -f "$current"
  ln -s "$dest" "$current"
  SOURCE_DIR="$current"
  log "current install -> $dest"
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

install_gemini() {
  if ! command -v gemini >/dev/null 2>&1; then
    warn "gemini not found; skipping Gemini CLI"
    return 0
  fi

  local generator="$SOURCE_DIR/scripts/build-gemini-extension.mjs"
  local validator="$SOURCE_DIR/scripts/validate-gemini-extension.mjs"
  local extension_root="$INSTALL_ROOT/gemini/dev"
  if [[ "$DRY_RUN" != "true" ]]; then
    [[ -f "$generator" ]] || die "source is missing scripts/build-gemini-extension.mjs"
    [[ -f "$validator" ]] || die "source is missing scripts/validate-gemini-extension.mjs"
  fi

  log "building Gemini dev extension from local package set $SOURCE_DIR"
  run node "$generator" --root "$SOURCE_DIR" --output "$extension_root"
  run node "$validator" --extension "$extension_root"

  # Gemini copies a local extension into its own home. Remove/reinstall makes a
  # repeat converge on the selected package set without asking the host to
  # update from GitHub or any package registry.
  try_run gemini extensions uninstall dev || true
  run gemini extensions install "$extension_root" --consent
}

install_hermes() {
  local installer="$SOURCE_DIR/scripts/install-hermes-skills.mjs"
  local hermes_home="${HERMES_HOME:-$HOME/.hermes}"
  if [[ "$DRY_RUN" != "true" ]]; then
    [[ -f "$installer" ]] || die "source is missing scripts/install-hermes-skills.mjs"
  fi
  log "installing complete Hermes dev skills from local package set $SOURCE_DIR"
  run node "$installer" --install --source "$SOURCE_DIR" --home "$hermes_home"
}

install_opencode_compatible() {
  local host="$1"
  local label="$2"
  if ! command -v "$host" >/dev/null 2>&1; then
    warn "$host not found; skipping $label"
    return 0
  fi

  if [[ "$DRY_RUN" != "true" ]]; then
    [[ -x "$SOURCE_DIR/scripts/install-opencode.sh" ]] || die "source is missing executable scripts/install-opencode.sh"
    require_cmd node
    if [[ ! -f "$SOURCE_DIR/dist/opencode-host.bundle.min.mjs" ]]; then
      require_cmd pnpm
    fi
  fi

  local args=("$SOURCE_DIR/scripts/install-opencode.sh" "--global" "--host" "$host")
  [[ "$OPENCODE_COPY" == "true" ]] && args+=("--copy")
  log "installing $label generated plugin surface from $SOURCE_DIR"
  run "${args[@]}"
}

install_opencode() { install_opencode_compatible opencode OpenCode; }
install_redcode() { install_opencode_compatible redcode RedCode; }

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
  # The universal installer points Pi at the composed, versioned runtime tree
  # so all hosts share one stable materialisation across re-runs. Direct Pi
  # installs may still use `npm:@reddb-io/red-skills-<plugin>`.
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

uninstall_gemini() {
  if ! command -v gemini >/dev/null 2>&1; then
    warn "gemini not found; skipping Gemini CLI"
    return 0
  fi
  try_run gemini extensions uninstall dev || true
}

hermes_source_dir_for_uninstall() {
  if [[ -n "$SOURCE_DIR" && -f "$SOURCE_DIR/scripts/install-hermes-skills.mjs" ]]; then
    printf '%s\n' "$SOURCE_DIR"
    return 0
  fi
  if [[ -f "$INSTALL_ROOT/current/scripts/install-hermes-skills.mjs" ]]; then
    printf '%s\n' "$INSTALL_ROOT/current"
    return 0
  fi
  return 1
}

uninstall_hermes() {
  local source hermes_home="${HERMES_HOME:-$HOME/.hermes}"
  if ! source="$(hermes_source_dir_for_uninstall)"; then
    warn "no RedSkills source found; skipped Hermes owned-state uninstall"
    return 0
  fi
  require_cmd node
  log "uninstalling Hermes RedSkills owned state"
  run node "$source/scripts/install-hermes-skills.mjs" --uninstall --home "$hermes_home"
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

uninstall_opencode_compatible() {
  local host="$1"
  local label="$2"
  local source
  if source="$(opencode_source_dir_for_uninstall)"; then
    log "uninstalling $label RedSkills files via $source/scripts/install-opencode.sh"
    run "$source/scripts/install-opencode.sh" --uninstall --global --host "$host"
    return 0
  fi

  local xdg_root="${XDG_CONFIG_HOME:-$HOME/.config}"
  local opencode_root="$xdg_root/$host"
  local plugins_dir="$opencode_root/plugins"
  local skills_dir="$opencode_root/skills"
  log "uninstalling $label RedSkills files from $opencode_root"

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
    warn "no RedSkills source checkout found; skipped $label skill comparison cleanup"
  fi

  remove_generated_config "$opencode_root/opencode.json"
  remove_generated_config "$opencode_root/opencode.jsonc"
  remove_redskills_tui "$opencode_root/tui.json"
  remove_redskills_tui "$opencode_root/tui.jsonc"
}

uninstall_opencode() { uninstall_opencode_compatible opencode OpenCode; }
uninstall_redcode() { uninstall_opencode_compatible redcode RedCode; }

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
  if has_uninstall_target gemini; then
    uninstall_gemini
    touched_any="true"
  fi
  if has_uninstall_target hermes; then
    uninstall_hermes
    touched_any="true"
  fi
  if has_uninstall_target opencode; then
    uninstall_opencode
    touched_any="true"
  fi
  if has_uninstall_target redcode; then
    uninstall_redcode
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
    warn "no supported CLIs/configs detected (claude, codex, gemini, hermes, opencode, redcode, pi)"
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
        claude|codex|gemini|hermes|opencode|redcode|pi) ;;
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

require_cmd node
if [[ -z "$SOURCE_DIR" ]]; then
  require_cmd npm
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
if has_target gemini; then
  install_gemini
  installed_any="true"
fi
if has_target hermes; then
  install_hermes
  installed_any="true"
fi
if has_target opencode; then
  install_opencode
  installed_any="true"
fi
if has_target redcode; then
  install_redcode
  installed_any="true"
fi
if has_target pi; then
  install_pi
  installed_any="true"
fi

if [[ "$installed_any" != "true" ]]; then
  warn "no supported CLIs detected (claude, codex, gemini, hermes, opencode, redcode, pi)"
fi

log "done"
log "restart open CLI sessions so they reload plugin manifests"
log "inside each repo, run /red-setup (Claude/OpenCode) or \$dev:red-setup (Codex when namespace-qualified)"
