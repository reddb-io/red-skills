#!/usr/bin/env bash
# Launch an AFK fleet inside its OWN systemd scope, so the fleet's memory is
# charged to a cgroup of its own instead of the terminal emulator's.
#
# Why this exists: `red-skills-dev fleet N` inherits the caller's cgroup. Launched
# from a terminal, every worker, every gate `pnpm install`, and every vitest fork
# is accounted to the terminal's scope. On a systemd-oomd host the fleet then makes
# the TERMINAL the largest cgroup, and oomd's pressure kill takes every terminal
# window, every agent session, and every MCP server with it — while the fleet is
# what actually generated the pressure.
#
# With its own scope the blast radius is the fleet: oomd (or MemoryHigh throttling)
# hits the scope that caused the pressure, the supervisor's watchdog respawns, and
# the terminals survive.
#
# Usage:
#   scripts/fleet-scoped.sh [target] [-- extra fleet args...]
#
# Environment:
#   RED_FLEET_NAME        scope/fleet name          (default: default)
#   RED_FLEET_MEMORY_HIGH soft cap, reclaim above   (default: 6G)
#   RED_AFK_RUNNER        runner passed through     (default: claude)
#   RED_SKILLS_VERSION    bundle version to dispatch (default: read from the plugin manifest)
#
# Without systemd --user (non-Linux, no session bus), it falls back to a direct
# launch and says so, rather than silently dropping the isolation.
set -euo pipefail

TARGET="${1:-2}"
[ $# -gt 0 ] && shift || true
[ "${1:-}" = "--" ] && shift || true

FLEET_NAME="${RED_FLEET_NAME:-default}"
MEMORY_HIGH="${RED_FLEET_MEMORY_HIGH:-6G}"
RUNNER="${RED_AFK_RUNNER:-claude}"
SCOPE_UNIT="red-fleet-${FLEET_NAME}.scope"

resolve_version() {
  if [ -n "${RED_SKILLS_VERSION:-}" ]; then
    printf '%s' "$RED_SKILLS_VERSION"
    return
  fi
  local manifest
  manifest="$(dirname "$0")/../plugins/dev/.claude-plugin/plugin.json"
  if [ -r "$manifest" ]; then
    sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest" | head -1
  fi
}

VERSION="$(resolve_version)"
if [ -z "$VERSION" ]; then
  echo "fleet-scoped: could not resolve the bundle version; set RED_SKILLS_VERSION" >&2
  exit 1
fi

# ADR 0091 canonical dispatch — never the bare shim.
FLEET_CMD=(npx -y -p "@reddb-io/red-skills@${VERSION}" red-skills-dev fleet "$TARGET" "$@")

if ! command -v systemd-run >/dev/null 2>&1 || ! systemctl --user show-environment >/dev/null 2>&1; then
  echo "fleet-scoped: no systemd --user session — launching WITHOUT cgroup isolation" >&2
  RED_AFK_RUNNER="$RUNNER" exec "${FLEET_CMD[@]}"
fi

if systemctl --user is-active --quiet "$SCOPE_UNIT" 2>/dev/null; then
  echo "fleet-scoped: $SCOPE_UNIT is already active — stop that fleet first" >&2
  exit 1
fi

echo "fleet-scoped: launching fleet '$FLEET_NAME' (target=$TARGET, runner=$RUNNER) in $SCOPE_UNIT"
echo "fleet-scoped: MemoryHigh=$MEMORY_HIGH, oomd pressure kill scoped to the fleet"

# --scope: the fleet launcher returns immediately after spawning a detached
# supervisor; the scope stays alive as long as any of its processes do, so the
# supervisor and every worker it spawns keep inheriting this cgroup.
# Delegate=yes lets the supervisor place its own children without asking systemd.
RED_AFK_RUNNER="$RUNNER" exec systemd-run --user --scope \
  --unit="red-fleet-${FLEET_NAME}" \
  --description="RedSkills AFK fleet ${FLEET_NAME}" \
  --property=Delegate=yes \
  --property="MemoryHigh=${MEMORY_HIGH}" \
  --property=ManagedOOMMemoryPressure=kill \
  --property=ManagedOOMMemoryPressureLimit=80% \
  -- "${FLEET_CMD[@]}"
