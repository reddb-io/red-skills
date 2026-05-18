#!/usr/bin/env bash
# gradle.sh — afk pre-spawn detector for Gradle projects.
#
# Applies when a build.gradle* file exists at PROJECT_ROOT AND the
# operator has opted in by setting GRADLE_USER_HOME_BASE. Exports
# GRADLE_USER_HOME=${GRADLE_USER_HOME_BASE}/slot-${AFK_SLOT} so each
# worker slot gets its own Gradle home (caches, daemons, lockfiles).
#
# Opt-in by env var is deliberate: we will not claim a path on the
# user's filesystem without their consent. Without
# GRADLE_USER_HOME_BASE the detector is a no-op (exit 1).
#
# Exit codes:
#   1 — not a Gradle project, or GRADLE_USER_HOME_BASE unset.
#   0 — applies; KEY=value line written to $AFK_HOOK_ENV_FILE.

set -u

project_root="${PROJECT_ROOT:-$(pwd)}"

shopt -s nullglob
matches=("$project_root"/build.gradle*)
shopt -u nullglob
[ "${#matches[@]}" -gt 0 ] || exit 1

[ -n "${GRADLE_USER_HOME_BASE:-}" ] || exit 1

slot="${AFK_SLOT:-0}"
home_dir="${GRADLE_USER_HOME_BASE}/slot-${slot}"

mkdir -p "$home_dir"

: "${AFK_HOOK_ENV_FILE:?AFK_HOOK_ENV_FILE not set}"
printf 'GRADLE_USER_HOME=%s\n' "$home_dir" >> "$AFK_HOOK_ENV_FILE"
exit 0
