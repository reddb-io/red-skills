#!/usr/bin/env bash
# RedSkills standalone installer — a handoff, not an owner.
#
# Intended curl entrypoint:
#   curl -fsSL https://raw.githubusercontent.com/reddb-io/red-skills/v3/scripts/install.sh | bash
#
# RedSkills is acquired and wired by red-dev, which mise installs and pins
# (`red-dev install` converges a machine toward its manifest, RedSkills wiring
# included). This script exists to put an operator who found the old one-liner
# on that path: it checks the platform red-dev supports, installs the pinned
# red-dev entry point through mise when it is missing, verifies that entry point
# answers, and hands over. It acquires no packages, registers no marketplace,
# writes no version tree and keeps no cache — a second owner of the same machine
# is the defect this shape removes.
#
# What it deliberately never does: heal a Directory-sourced marketplace back to
# the GitHub source. A directory registration is what red-dev writes, so the
# heal the previous installer performed on every re-run tore out the wiring this
# script now hands ownership to.
#
# `--local-dev --source-dir <checkout>` is the development escape hatch: it
# wires the hosts from a checkout you already have, says out loud that it is not
# a production installation, and still owns nothing outside that checkout.
#
# `--uninstall` remains, and is how a machine retires the tree and registrations
# the retired standalone path left behind. OpenCode-compatible uninstall is
# conservative: manifest-recorded files are removed, generated modules/configs
# are removed when they still match RedSkills output, and unrelated user files
# are kept.

set -euo pipefail

# The pinned bootstrap entry point. red-dev owns the acquisition contract, so the
# spec names a major it guarantees rather than `latest`; mise resolves the exact
# revision and records it. `--red-dev-spec` overrides it for a pre-release.
RED_DEV_SPEC="${RED_SKILLS_RED_DEV_SPEC:-red-dev@1}"

# Where the retired standalone path put its tree. Kept for `--uninstall
# --purge`, which is how that tree leaves a machine, and as the scratch root the
# escape hatch generates host surfaces into.
INSTALL_ROOT="${RED_SKILLS_INSTALL_ROOT:-$HOME/.red/skills}"
LOCAL_DEV_ROOT="$INSTALL_ROOT/local-dev"

ONLY="${RED_SKILLS_ONLY:-auto}"
CLAUDE_SCOPE="${RED_SKILLS_CLAUDE_SCOPE:-user}"
PI_SCOPE="${RED_SKILLS_PI_SCOPE:-user}"
PI_PROJECT_DIR=""
SOURCE_DIR="${RED_SKILLS_SOURCE_DIR:-}"
ACTION="${RED_SKILLS_ACTION:-install}"
LOCAL_DEV="${RED_SKILLS_LOCAL_DEV:-false}"
FORCE="${RED_SKILLS_FORCE:-false}"
PURGE="${RED_SKILLS_PURGE:-false}"
DRY_RUN="false"
OPENCODE_COPY="${RED_SKILLS_OPENCODE_COPY:-false}"

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Hands this machine to the canonical mise/red-dev bootstrap (`mise use --global
red-dev@<pin>`, then `red-dev install`), which owns RedSkills acquisition and
host wiring. This script installs nothing of its own.

Options:
  --red-dev-spec <spec> mise spec for the bootstrap entry point
                        (default: red-dev@1)
  --local-dev           Development escape hatch: wire the detected hosts from a
                        checkout instead of handing off. Requires --source-dir.
                        Not a production installation.
  --source-dir <dir>    The red-skills checkout --local-dev wires from, and the
                        one --uninstall reads its host-unwiring scripts from.
  --only <list>         Comma list: claude,codex,gemini,hermes,opencode,redcode,pi
                        (default: auto-detect). Applies to --local-dev and
                        --uninstall.
  --claude-scope <s>    Claude install scope: user, project, or local (default: user)
  --pi-scope <s>        Pi install scope: user or project (default: user)
  --install-root <dir>  Where the retired standalone tree lives, for --purge
                        (default: ~/.red/skills)
  --uninstall           Remove RedSkills from detected/specified CLIs
  --force               With --local-dev: reinstall plugins, and replace a
                        directory-sourced marketplace registration this script
                        would otherwise leave to red-dev
  --purge               With --uninstall, also remove the standalone install tree
  --opencode-copy       Copy OpenCode-compatible SKILL.md files instead of symlinking
  --dry-run             Print actions without writing
  -h, --help            Show this help

Environment:
  RED_SKILLS_RED_DEV_SPEC, RED_SKILLS_LOCAL_DEV, RED_SKILLS_INSTALL_ROOT,
  RED_SKILLS_ONLY, RED_SKILLS_CLAUDE_SCOPE, RED_SKILLS_PI_SCOPE,
  RED_SKILLS_SOURCE_DIR, RED_SKILLS_ACTION, RED_SKILLS_FORCE,
  RED_SKILLS_PURGE, RED_SKILLS_OPENCODE_COPY.
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

# ── the handoff ────────────────────────────────────────────────────────────

PLATFORM_OS=""
PLATFORM_ARCH=""

detect_platform() {
  PLATFORM_OS="$(uname -s 2>/dev/null || true)"
  PLATFORM_ARCH="$(uname -m 2>/dev/null || true)"
  [[ -n "$PLATFORM_OS" ]] || PLATFORM_OS="unknown"
  [[ -n "$PLATFORM_ARCH" ]] || PLATFORM_ARCH="unknown"
}

# The platforms the red-dev bootstrap installs on. Anything else is refused
# before a single file is written: handing an operator to a bootstrap that
# cannot run there, and then quietly installing something else instead, is the
# dead end this whole change removes.
platform_supported() {
  case "$PLATFORM_OS" in
    Linux | Darwin) ;;
    *) return 1 ;;
  esac
  case "$PLATFORM_ARCH" in
    x86_64 | amd64 | arm64 | aarch64) return 0 ;;
    *) return 1 ;;
  esac
}

# The bootstrap entry point, resolved before it is trusted. `command -v` covers
# an operator who already has red-dev; `mise which` covers the shell that has
# not picked up mise's shims yet. An unresolvable entry point is never assumed.
resolve_red_dev() {
  local resolved
  if resolved="$(command -v red-dev 2>/dev/null)" && [[ -n "$resolved" ]]; then
    printf '%s\n' "$resolved"
    return 0
  fi
  if command -v mise >/dev/null 2>&1; then
    resolved="$(mise which red-dev 2>/dev/null || true)"
    if [[ -n "$resolved" && -x "$resolved" ]]; then
      printf '%s\n' "$resolved"
      return 0
    fi
  fi
  return 1
}

# A machine that still carries the retired tree is told so once. This script
# never refreshes, re-adopts or heals it — red-dev owns the wiring now, and the
# tree leaves through --uninstall --purge when the operator is ready.
report_retired_tree() {
  [[ -d "$INSTALL_ROOT" ]] || return 0
  warn "a standalone RedSkills tree remains at $INSTALL_ROOT; it is no longer read or updated"
  warn "retire it once red-dev has wired this machine: install.sh --uninstall --purge"
}

hand_off_to_red_dev() {
  detect_platform
  if ! platform_supported; then
    die "$(printf '%s\n' \
      "unsupported platform ${PLATFORM_OS}/${PLATFORM_ARCH}: the red-dev bootstrap targets Linux and macOS on x86_64 or arm64." \
      "  wire this host by hand — docs/INSTALL.md walks each CLI" \
      "  or develop from a checkout: install.sh --local-dev --source-dir <checkout>")"
  fi

  log "platform ${PLATFORM_OS}/${PLATFORM_ARCH} is supported"
  log "RedSkills is acquired and wired by red-dev; handing over to $RED_DEV_SPEC"
  report_retired_tree

  if [[ "$DRY_RUN" == "true" ]]; then
    log "would run: mise use --global $RED_DEV_SPEC (when red-dev is absent)"
    log "would run: red-dev --version, then red-dev install"
    return 0
  fi

  local entry
  if ! entry="$(resolve_red_dev)"; then
    command -v mise >/dev/null 2>&1 || die "$(printf '%s\n' \
      "neither red-dev nor mise is installed, and this script no longer installs RedSkills itself." \
      "  1. install mise: https://mise.jdx.dev/installing-mise.html" \
      "  2. mise use --global $RED_DEV_SPEC" \
      "  3. red-dev install")"
    log "installing the pinned bootstrap $RED_DEV_SPEC through mise"
    run mise use --global "$RED_DEV_SPEC"
    entry="$(resolve_red_dev)" || die "could not run red-dev after installing $RED_DEV_SPEC through mise; open a new shell so mise's shims are on PATH, then run: red-dev install"
  fi

  log "bootstrap entry point: $entry ($RED_DEV_SPEC)"
  run "$entry" --version || die "could not run red-dev --version at $entry; the bootstrap entry point is not usable, so nothing was handed over"
  run "$entry" install
  log "red-dev owns this machine's RedSkills install from here"
}

# ── the development escape hatch ───────────────────────────────────────────

# The checkout --local-dev wires from. There is no acquisition fallback on
# purpose: an escape hatch that can fetch a release is an installation path
# wearing a development label.
prepare_local_dev_source() {
  [[ -n "$SOURCE_DIR" ]] \
    || die "--local-dev wires a checkout you already have: pass --source-dir <red-skills checkout>"
  [[ -d "$SOURCE_DIR" ]] || die "--source-dir does not exist: $SOURCE_DIR"
  SOURCE_DIR="$(cd "$SOURCE_DIR" && pwd)"
  [[ -f "$SOURCE_DIR/.claude-plugin/marketplace.json" ]] || die "source dir is missing .claude-plugin/marketplace.json"
  [[ -f "$SOURCE_DIR/.agents/plugins/marketplace.json" ]] || die "source dir is missing .agents/plugins/marketplace.json"
}

announce_local_dev() {
  log "local development install — this is not a production installation"
  log "  wiring from the checkout $SOURCE_DIR"
  log "  nothing here tracks a release, updates itself, or is supported for daily use"
  log "  the supported install is the red-dev bootstrap ($RED_DEV_SPEC)"
}


# Read one marketplace's registered source kind from a `plugin marketplace list`
# transcript on stdin. The rendered shape is an entry line followed by an
# indented `Source: <Kind> (<detail>)` line:
#
#   Configured marketplaces:
#
#     ❯ red-skills
#       Source: Directory (/home/…/.red/skills/current)
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

# Register the checkout as one host CLI's marketplace source.
#
# Never the GitHub source: this script owns no RedSkills release any more, and a
# GitHub registration it wrote would be a second owner racing red-dev's. A
# `directory` registration is the shape red-dev writes, so it is left exactly
# where it is unless the operator says --force; a `github` one is the retired
# standalone path's own leftover, and the checkout replaces it.
register_dev_marketplace() {
  local cli="$1"
  shift
  local -a add_args=("$@")
  local kind
  kind="$(host_marketplace_kind "$cli")"

  case "$kind" in
    directory)
      if [[ "$FORCE" != "true" ]]; then
        warn "$cli already carries a directory-sourced red-skills marketplace; leaving it registered"
        warn "  red-dev owns directory registrations — re-run with --force to point $cli at $SOURCE_DIR instead"
        return 0
      fi
      warn "--force: replacing $cli's directory-sourced red-skills marketplace with $SOURCE_DIR"
      try_run "$cli" plugin marketplace remove red-skills || true
      ;;
    github | git)
      warn "$cli carries a $kind-sourced red-skills marketplace from the retired standalone installer; replacing it with $SOURCE_DIR"
      try_run "$cli" plugin marketplace remove red-skills || true
      ;;
    unknown)
      # Replacing a registration we could not read would discard whatever the
      # operator configured, so this adds without removing anything.
      warn "$cli could not report its red-skills marketplace source; adding $SOURCE_DIR without removing anything"
      ;;
  esac

  if try_run "$cli" "${add_args[@]}" "$SOURCE_DIR"; then
    return 0
  fi
  [[ "$kind" == "absent" ]] && die "$cli marketplace add failed"
  warn "$cli marketplace add failed; leaving the existing registration in place"
}

install_claude() {
  if ! command -v claude >/dev/null 2>&1; then
    warn "claude not found; skipping Claude Code"
    return 0
  fi

  log "wiring Claude Code from the checkout $SOURCE_DIR"
  register_dev_marketplace claude plugin marketplace add --scope "$CLAUDE_SCOPE"

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

  log "wiring Codex CLI from the checkout $SOURCE_DIR"
  register_dev_marketplace codex plugin marketplace add

  local plugin
  for plugin in dev memory brain; do
    # Codex currently has marketplace upgrade but no plugin update command.
    # Remove/re-add to make a rerun converge on the registered checkout.
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
  local extension_root="$LOCAL_DEV_ROOT/gemini/dev"
  if [[ "$DRY_RUN" != "true" ]]; then
    [[ -f "$generator" ]] || die "source is missing scripts/build-gemini-extension.mjs"
    [[ -f "$validator" ]] || die "source is missing scripts/validate-gemini-extension.mjs"
  fi

  log "building Gemini dev extension from the checkout $SOURCE_DIR"
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
  log "installing complete Hermes dev skills from the checkout $SOURCE_DIR"
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
    [[ -f "$SOURCE_DIR/scripts/install-opencode.sh" ]] || die "source is missing scripts/install-opencode.sh"
    require_cmd node
    if [[ ! -f "$SOURCE_DIR/dist/opencode-host.bundle.min.mjs" ]]; then
      require_cmd pnpm
    fi
  fi

  # Run through bash rather than exec: the npm tarball keeps the executable
  # bit only for `bin` entries, so a materialised scripts/*.sh arrives 0644
  # (the v3.19.2 install died on the -x test with everything else in place).
  local args=(bash "$SOURCE_DIR/scripts/install-opencode.sh" "--global" "--host" "$host")
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
    [[ -f "$SOURCE_DIR/scripts/install-pi.sh" ]] || die "source is missing scripts/install-pi.sh"
    require_cmd node
  fi

  local args=(bash "$SOURCE_DIR/scripts/install-pi.sh")
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
  if [[ -n "$SOURCE_DIR" && -f "$SOURCE_DIR/scripts/install-opencode.sh" ]] \
    && grep -Fq -- '--uninstall' "$SOURCE_DIR/scripts/install-opencode.sh"; then
    printf '%s\n' "$SOURCE_DIR"
    return 0
  fi
  if [[ -f "$INSTALL_ROOT/current/scripts/install-opencode.sh" ]] \
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
      run bash "$source/scripts/install-pi.sh" --uninstall --user
    fi
    if [[ -n "$manifest_project" && -f "$manifest_project" ]]; then
      ( cd "$PI_PROJECT_DIR" && run bash "$source/scripts/install-pi.sh" --uninstall --project "$PI_PROJECT_DIR" )
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
    run bash "$source/scripts/install-opencode.sh" --uninstall --global --host "$host"
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
    --red-dev-spec)
      [[ $# -ge 2 ]] || die "$1 requires a value"
      RED_DEV_SPEC="$2"
      shift 2
      ;;
    --local-dev)
      LOCAL_DEV="true"
      shift
      ;;
    --install-root)
      [[ $# -ge 2 ]] || die "$1 requires a value"
      INSTALL_ROOT="$2"
      LOCAL_DEV_ROOT="$INSTALL_ROOT/local-dev"
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

if [[ "$LOCAL_DEV" != "true" ]]; then
  hand_off_to_red_dev
  exit 0
fi

# The escape hatch from here down. It needs node because every host surface
# below the marketplace is generated (Gemini extension, OpenCode/RedCode plugins,
# Pi packages), and it needs a checkout because it acquires nothing.
require_cmd node
prepare_local_dev_source
announce_local_dev

wired_any="false"
if has_target claude; then
  install_claude
  wired_any="true"
fi
if has_target codex; then
  install_codex
  wired_any="true"
fi
if has_target gemini; then
  install_gemini
  wired_any="true"
fi
if has_target hermes; then
  install_hermes
  wired_any="true"
fi
if has_target opencode; then
  install_opencode
  wired_any="true"
fi
if has_target redcode; then
  install_redcode
  wired_any="true"
fi
if has_target pi; then
  install_pi
  wired_any="true"
fi

if [[ "$wired_any" != "true" ]]; then
  warn "no supported CLIs detected (claude, codex, gemini, hermes, opencode, redcode, pi)"
fi

log "done — local development wiring from $SOURCE_DIR, not a production installation"
log "restart open CLI sessions so they reload plugin manifests"
log "inside each repo, run /red-setup (Claude/OpenCode) or \$dev:red-setup (Codex when namespace-qualified)"
