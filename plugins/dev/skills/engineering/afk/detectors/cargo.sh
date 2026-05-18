#!/usr/bin/env bash
# cargo.sh — afk pre-spawn detector for Rust projects.
#
# Applies when a Cargo.toml exists at PROJECT_ROOT. Exports
# CARGO_TARGET_DIR=${CARGO_TARGET_BASE:-/opt/cargo-target}/slot-${AFK_SLOT}
# so each worker slot gets its own target directory and Cargo
# never serializes on .cargo-lock between workers.
#
# Exit codes:
#   1 — not a Rust project (no Cargo.toml). The orchestrator treats
#       this as "skip silently".
#   0 — applies; KEY=value line(s) written to $AFK_HOOK_ENV_FILE.

set -u

project_root="${PROJECT_ROOT:-$(pwd)}"
[ -f "$project_root/Cargo.toml" ] || exit 1

slot="${AFK_SLOT:-0}"
base="${CARGO_TARGET_BASE:-/opt/cargo-target}"
target_dir="${base}/slot-${slot}"

mkdir -p "$target_dir"

: "${AFK_HOOK_ENV_FILE:?AFK_HOOK_ENV_FILE not set}"
printf 'CARGO_TARGET_DIR=%s\n' "$target_dir" >> "$AFK_HOOK_ENV_FILE"
exit 0
