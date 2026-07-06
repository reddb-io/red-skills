#!/usr/bin/env bash
# afk-promote-channel.sh — move the AFK canary channel npm dist-tag (ADR 0058/0091).
#
# The client no longer reads GitHub floating release tags for plugin bundles.
# `stable` resolves the installed version's npm package; `canary` resolves the
# npm `canary` dist-tag for @reddb-io/red-skills. Promotion therefore means:
#
#   cut <version>          point npm dist-tag `canary` at a published stable version
#   promote <version>      alias for `cut <version>`
#   rollback <version>     point npm dist-tag `canary` back at a prior stable version
#   status                 show npm dist-tags for the package
#
# The old no-argument `promote` flow (canary GitHub tag -> stable GitHub tag) is
# retired. Stable is published by red-release as the npm `latest` dist-tag; this
# script only moves the opt-in canary pointer.
#
# Mutating npm dist-tags requires NODE_AUTH_TOKEN or NPM_TOKEN. `--force` skips
# the confirmation prompt only; it never skips token and published-version checks.

set -euo pipefail

PACKAGE="${RED_PROMOTE_NPM_PACKAGE:-@reddb-io/red-skills}"
CANARY_TAG="${RED_PROMOTE_CANARY_TAG:-canary}"
FORCE=0
NPM_USERCONFIG_FILE=""

die() { printf 'afk-promote-channel: %s\n' "$*" >&2; exit 1; }

cleanup() {
  [ -z "$NPM_USERCONFIG_FILE" ] || rm -f "$NPM_USERCONFIG_FILE"
}
trap cleanup EXIT

usage() {
  sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

confirm() {
  [ "$FORCE" = 1 ] && return 0
  printf '%s [y/N] ' "$1" >&2
  read -r reply
  case "$reply" in y|Y|yes|YES) return 0 ;; *) die "aborted" ;; esac
}

normalize_stable_version() {
  local raw="${1:-}" version
  [ -n "$raw" ] || die "version is required"
  version="${raw#v}"
  if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(\+[0-9A-Za-z.-]+)?$ ]]; then
    die "canary must point at a published stable semver version, got '$raw'"
  fi
  printf '%s\n' "$version"
}

require_npm_token() {
  if [ -n "${NODE_AUTH_TOKEN:-}" ]; then
    return 0
  fi
  if [ -n "${NPM_TOKEN:-}" ]; then
    export NODE_AUTH_TOKEN="$NPM_TOKEN"
    return 0
  fi
  die "NODE_AUTH_TOKEN or NPM_TOKEN is required to mutate npm dist-tags"
}

prepare_npm_auth() {
  require_npm_token
  NPM_USERCONFIG_FILE="$(mktemp)"
  chmod 600 "$NPM_USERCONFIG_FILE"
  printf '//registry.npmjs.org/:_authToken=%s\n' "$NODE_AUTH_TOKEN" >"$NPM_USERCONFIG_FILE"
}

assert_published_version() {
  local version="$1"
  npm view "${PACKAGE}@${version}" version >/dev/null \
    || die "${PACKAGE}@${version} is not visible on npm; publish it before moving ${CANARY_TAG}"
}

cmd_status() {
  npm dist-tag ls "$PACKAGE" \
    || die "could not read npm dist-tags for ${PACKAGE}"
}

set_canary() {
  local action="$1" version
  version="$(normalize_stable_version "${2:-}")"
  assert_published_version "$version"
  prepare_npm_auth
  confirm "${action}: point npm dist-tag ${CANARY_TAG} at ${PACKAGE}@${version}?"
  npm --userconfig "$NPM_USERCONFIG_FILE" dist-tag add "${PACKAGE}@${version}" "$CANARY_TAG" \
    || die "failed to point ${CANARY_TAG} at ${PACKAGE}@${version}"
  printf 'moved npm dist-tag %s -> %s@%s\n' "$CANARY_TAG" "$PACKAGE" "$version"
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
    cut)      set_canary "cut" "${1:-}" ;;
    promote)  set_canary "promote" "${1:-}" ;;
    rollback) set_canary "rollback" "${1:-}" ;;
    ""|help)  usage 0 ;;
    *)        die "unknown subcommand '$sub' (try: status | cut <version> | promote <version> | rollback <version>)" ;;
  esac
}

main "$@"
