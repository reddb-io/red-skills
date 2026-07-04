#!/usr/bin/env bash
# afk-promote-channel.sh — move the AFK bundle release-channel tags (ADR 0058).
#
# A release channel is a floating git tag that the ADR 0038 launcher resolves the
# dev bundle from:
#
#   stable  — the version-pinned `v<version>` release; ALSO mirrored by an
#             operator-facing floating `stable` tag advanced here on promotion.
#   canary  — the floating `canary` tag the canary channel tracks.
#
# Promotion (canary → stable) and rollback are BOTH just a tag move:
#
#   cut <ref>        point `canary` at <ref> and push it           (publish a canary)
#   promote          move `stable` onto wherever `canary` points   (promote canary → stable)
#   rollback <ch> <ref>   force-move channel <ch>'s tag back to <ref>   (rollback)
#   status           show where the stable/canary tags point
#
# Promotion is GATED on the proof-by-drain telemetry
# (apps/dev/src/core/proof-by-drain.ts): a canary must clear the ADR 0058 bar
# (≥20 landed merges over ≥24h with a failure ratio ≤0.10) before `promote`. This
# script performs the tag move; it does NOT evaluate the gate — run the gate
# first and only `promote` when it is green. `--force` skips the confirmation
# prompt but never the gate.
#
# The bundle ASSETS (`dev.bundle.min.mjs` + `dev.manifest.json` +
# `dev.manifest.json.sigstore.json`) for the canary release are built and
# uploaded by the red-release flow; this script only moves the pointers. After a
# `cut`/`rollback`, refresh the `canary` GitHub Release assets so the tag and its
# payload agree (see `gh release upload --clobber`).

set -euo pipefail

REMOTE="${RED_PROMOTE_REMOTE:-origin}"
FORCE=0

die() { printf 'afk-promote-channel: %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

require_tag() {
  case "$1" in
    stable|canary) : ;;
    *) die "unknown channel '$1' (expected: stable | canary)" ;;
  esac
}

move_tag() {
  # move_tag <tag> <ref> — force-create <tag> at <ref> and push it.
  local tag="$1" ref="$2"
  git rev-parse --verify --quiet "${ref}^{commit}" >/dev/null \
    || die "ref '${ref}' does not resolve to a commit"
  git tag -f "$tag" "$ref" >/dev/null
  git push -f "$REMOTE" "refs/tags/${tag}"
  printf 'moved tag %-7s -> %s (%s)\n' "$tag" "$ref" "$(git rev-parse --short "${ref}^{commit}")"
}

confirm() {
  [ "$FORCE" = 1 ] && return 0
  printf '%s [y/N] ' "$1" >&2
  read -r reply
  case "$reply" in y|Y|yes|YES) return 0 ;; *) die "aborted" ;; esac
}

cmd_status() {
  for tag in stable canary; do
    if git rev-parse --verify --quiet "refs/tags/${tag}" >/dev/null; then
      printf '%-7s -> %s\n' "$tag" "$(git rev-parse --short "refs/tags/${tag}")"
    else
      printf '%-7s -> (unset)\n' "$tag"
    fi
  done
}

cmd_cut() {
  local ref="${1:-HEAD}"
  confirm "Point canary at ${ref}?"
  move_tag canary "$ref"
  printf 'next: refresh the canary release assets, e.g.\n'
  printf '  gh release upload canary dist/dev.bundle.min.mjs dist/dev.manifest.json dist/dev.manifest.json.sigstore.json --clobber\n'
}

cmd_promote() {
  git rev-parse --verify --quiet "refs/tags/canary" >/dev/null \
    || die "no canary tag to promote — cut a canary first"
  local ref
  ref="$(git rev-parse refs/tags/canary)"
  printf 'Promotion is gated on proof-by-drain — promote only when the gate is green.\n' >&2
  confirm "Move stable onto the canary commit ${ref:0:8}?"
  move_tag stable "$ref"
}

cmd_rollback() {
  local channel="${1:-}" ref="${2:-}"
  [ -n "$channel" ] && [ -n "$ref" ] || die "rollback needs <channel> <ref>"
  require_tag "$channel"
  confirm "Roll ${channel} back to ${ref}?"
  move_tag "$channel" "$ref"
}

main() {
  local args=()
  for a in "$@"; do
    case "$a" in
      --force|-f) FORCE=1 ;;
      -h|--help) usage 0 ;;
      *) args+=("$a") ;;
    esac
  done
  set -- "${args[@]:-}"
  local sub="${1:-status}"; shift || true
  case "$sub" in
    status)   cmd_status "$@" ;;
    cut)      cmd_cut "$@" ;;
    promote)  cmd_promote "$@" ;;
    rollback) cmd_rollback "$@" ;;
    ""|help)  usage 0 ;;
    *)        die "unknown subcommand '$sub' (try: status | cut | promote | rollback)" ;;
  esac
}

main "$@"
