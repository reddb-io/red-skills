#!/usr/bin/env bash
set -u

# Path of the drained stdin payload. The host writes the hook payload to our
# stdin *after* spawning us, so every exit path — including the fail-open ones —
# must drain stdin first; exiting with the pipe still unread makes the host's
# write fail with EPIPE.
STDIN_PAYLOAD=""
tmp=""
cleanup() {
  [ -n "$STDIN_PAYLOAD" ] && rm -f "$STDIN_PAYLOAD" 2>/dev/null
  return 0
}
trap cleanup EXIT

debug_enabled() {
  case "${RED_SKILLS_HOOK_DEBUG:-}" in
    1|true|TRUE|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

debug() {
  debug_enabled || return 0
  printf 'rsp-hook: %s\n' "$*" >&2
}

print_empty_json() {
  printf '{}'
}

plugin_root() {
  local root
  for root in \
    "${RED_SKILLS_DEV_PLUGIN_ROOT:-}" \
    "${CLAUDE_PLUGIN_ROOT:-}" \
    "${CODEX_PLUGIN_ROOT:-}" \
    "${OPENCODE_PLUGIN_ROOT:-}"
  do
    [ -n "$root" ] || continue
    printf '%s\n' "$root"
    return 0
  done
  return 1
}

plugin_manifest() {
  local root="$1" manifest
  for manifest in \
    "$root/.claude-plugin/plugin.json" \
    "$root/.codex-plugin/plugin.json"
  do
    [ -f "$manifest" ] || continue
    printf '%s\n' "$manifest"
    return 0
  done
  return 1
}

plugin_manifest_for_hook() {
  local root="$1" hook_name="$2" manifest
  case "$hook_name" in
    codex-*) manifest="$root/.codex-plugin/plugin.json" ;;
    *) manifest="$root/.claude-plugin/plugin.json" ;;
  esac
  if [ -f "$manifest" ]; then
    printf '%s\n' "$manifest"
    return 0
  fi
  plugin_manifest "$root"
}

cache_dir() {
  printf '%s\n' "${RED_SKILLS_RSP_HOOK_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/red-skills/hook-cache}"
}

cache_file() {
  local root="$1" dir key
  if [ -z "${RED_SKILLS_RSP_HOOK_CACHE_DIR:-}" ]; then
    printf '%s/.red-skills-rsp-hook.cache\n' "$root"
    return 0
  fi
  dir="$(cache_dir)" || return 1
  key="$(printf '%s' "$root" | cksum | cut -d ' ' -f 1)" || return 1
  [ -n "$key" ] || return 1
  printf '%s/rsp-%s.cache\n' "$dir" "$key"
}

with_timeout() {
  if command -v timeout >/dev/null 2>&1; then
    timeout "${RED_SKILLS_HOOK_TIMEOUT_S:-3s}" "$@"
  else
    "$@"
  fi
}

read_stdin_to() {
  local target="$1" budget line
  if command -v timeout >/dev/null 2>&1; then
    timeout "${RED_SKILLS_HOOK_STDIN_TIMEOUT_S:-5s}" cat >"$target" 2>/dev/null || true
    return 0
  fi
  # No `timeout(1)` on this box: bound the drain with bash's own read timeout
  # so a host that never closes the pipe cannot hang the hook.
  budget="${RED_SKILLS_HOOK_STDIN_TIMEOUT_S:-5s}"
  budget="${budget%s}"
  : >"$target" 2>/dev/null || return 0
  while IFS= read -r -t "$budget" line || [ -n "$line" ]; do
    printf '%s\n' "$line" >>"$target" 2>/dev/null || break
    line=""
  done
  return 0
}

# Drain stdin BEFORE any fail-open decision. Idempotent: the first call wins.
drain_stdin() {
  [ -z "$STDIN_PAYLOAD" ] || return 0
  STDIN_PAYLOAD="$(mktemp "${TMPDIR:-/tmp}/red-skills-rsp-hook.XXXXXX" 2>/dev/null)" || STDIN_PAYLOAD=""
  if [ -z "$STDIN_PAYLOAD" ]; then
    # No temp file: still drain, so the writer never sees EPIPE.
    read_stdin_to /dev/null
    return 0
  fi
  read_stdin_to "$STDIN_PAYLOAD"
}

find_rsp_bundle() {
  local root bundle dir latest cache_root version
  for root in \
    "${RED_SKILLS_DEV_PLUGIN_ROOT:-}" \
    "${CLAUDE_PLUGIN_ROOT:-}" \
    "${CODEX_PLUGIN_ROOT:-}" \
    "${OPENCODE_PLUGIN_ROOT:-}"
  do
    [ -n "$root" ] || continue
    for bundle in "$root/../../dist/rsp.bundle.min.mjs" "$root/dist/rsp.bundle.min.mjs"; do
      [ -f "$bundle" ] || continue
      printf '%s\n' "$bundle"
      return 0
    done
  done

  latest="$(
    for dir in "$HOME"/.codex/plugins/cache/red-skills/dev/* "$HOME"/.claude/plugins/cache/red-skills/dev/*; do
      [ -d "$dir" ] || continue
      for bundle in "$dir/../../dist/rsp.bundle.min.mjs" "$dir/dist/rsp.bundle.min.mjs"; do
        [ -f "$bundle" ] && printf '%s\t%s\n' "$(basename "$dir")" "$bundle"
      done
    done | sort -V | tail -1 | cut -f2-
  )"
  if [ -n "$latest" ]; then
    printf '%s\n' "$latest"
    return 0
  fi

  cache_root="${RED_SKILLS_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/red-skills/bundles}"
  latest="$(
    for bundle in "$cache_root"/.staging-rsp-*/node_modules/@reddb-io/red-skills/dist/rsp.bundle.min.mjs; do
      [ -f "$bundle" ] || continue
      dir="${bundle%/node_modules/@reddb-io/red-skills/dist/rsp.bundle.min.mjs}"
      version="${dir##*/.staging-rsp-}"
      printf '%s\t%s\n' "$version" "$bundle"
    done | sort -V | tail -1 | cut -f2-
  )"
  if [ -n "$latest" ]; then
    printf '%s\n' "$latest"
    return 0
  fi

  if [ -f "$cache_root/rsp.bundle.min.mjs" ]; then
    printf '%s\n' "$cache_root/rsp.bundle.min.mjs"
    return 0
  fi

  latest="$(
    for bundle in "$cache_root"/rsp-*.bundle.min.mjs; do
      [ -f "$bundle" ] || continue
      version="${bundle##*/rsp-}"
      version="${version%.bundle.min.mjs}"
      printf '%s\t%s\n' "$version" "$bundle"
    done | sort -V | tail -1 | cut -f2-
  )"
  [ -n "$latest" ] || return 1
  printf '%s\n' "$latest"
}

find_red_binary() {
  local cache_root red version latest
  cache_root="${RED_SKILLS_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/red-skills/bundles}"
  latest="$(
    for red in "$cache_root"/reddb/*/red "$cache_root"/reddb/*/red.exe; do
      [ -x "$red" ] || continue
      version="${red%/*}"
      version="${version##*/}"
      printf '%s\t%s\n' "$version" "$red"
    done | sort -V | tail -1 | cut -f2-
  )"
  [ -n "$latest" ] || return 1
  printf '%s\n' "$latest"
}

prime_cache() {
  local root cache bundle red tmp manifest dir
  drain_stdin
  root="$(plugin_root || true)"
  if [ -z "$root" ]; then
    debug "prime skipped: plugin root is unset"
    print_empty_json
    return 0
  fi

  cache="$(cache_file "$root" || true)"
  if [ -z "$cache" ]; then
    debug "prime skipped: cache path could not be derived"
    print_empty_json
    return 0
  fi

  bundle="$(find_rsp_bundle || true)"
  if [ -z "$bundle" ]; then
    rm -f "$cache" 2>/dev/null || true
    debug "prime skipped: rsp bundle not found"
    print_empty_json
    return 0
  fi

  red="$(find_red_binary || true)"
  manifest="$(plugin_manifest "$root" || true)"
  dir="${cache%/*}"
  mkdir -p "$dir" 2>/dev/null || {
    debug "prime skipped: cache directory is not writable"
    print_empty_json
    return 0
  }

  tmp="${cache}.$$"
  {
    printf 'PLUGIN_ROOT=%s\n' "$root"
    printf 'PLUGIN_MANIFEST=%s\n' "$manifest"
    printf 'RSP_BUNDLE=%s\n' "$bundle"
    printf 'REDDB_BIN=%s\n' "$red"
  } >"$tmp" 2>/dev/null && mv "$tmp" "$cache" 2>/dev/null || {
    rm -f "$tmp" 2>/dev/null || true
    debug "prime skipped: cache write failed"
    print_empty_json
    return 0
  }

  debug "primed cache for rsp bundle"
  print_empty_json
}

load_cache() {
  local cache="$1" key value
  RSP_HOOK_CACHED_ROOT=""
  RSP_HOOK_CACHED_MANIFEST=""
  RSP_HOOK_CACHED_BUNDLE=""
  RSP_HOOK_CACHED_REDDB_BIN=""

  while IFS='=' read -r key value || [ -n "$key" ]; do
    case "$key" in
      PLUGIN_ROOT) RSP_HOOK_CACHED_ROOT="$value" ;;
      PLUGIN_MANIFEST) RSP_HOOK_CACHED_MANIFEST="$value" ;;
      RSP_BUNDLE) RSP_HOOK_CACHED_BUNDLE="$value" ;;
      REDDB_BIN) RSP_HOOK_CACHED_REDDB_BIN="$value" ;;
    esac
  done <"$cache"
}

run_bundle() {
  local hook_name="$1"
  if [ -n "$STDIN_PAYLOAD" ]; then
    with_timeout node "$RSP_HOOK_CACHED_BUNDLE" hook "$hook_name" <"$STDIN_PAYLOAD"
  else
    with_timeout node "$RSP_HOOK_CACHED_BUNDLE" hook "$hook_name"
  fi
}

run_hook() {
  local hook_name="$1" root cache manifest rc
  drain_stdin
  root="$(plugin_root || true)"
  if [ -z "$root" ]; then
    debug "$hook_name fail-open: plugin root is unset"
    return 0
  fi

  cache="$(cache_file "$root" || true)"
  if [ -z "$cache" ] || [ ! -f "$cache" ]; then
    debug "$hook_name fail-open: rsp cache is missing"
    return 0
  fi

  load_cache "$cache" || {
    debug "$hook_name fail-open: rsp cache could not be read"
    return 0
  }

  if [ "$RSP_HOOK_CACHED_ROOT" != "$root" ]; then
    debug "$hook_name fail-open: rsp cache root mismatch"
    return 0
  fi

  manifest="$(plugin_manifest_for_hook "$root" "$hook_name" || true)"
  if [ -n "$manifest" ] && [ "$manifest" -nt "$cache" ]; then
    debug "$hook_name fail-open: stale rsp cache"
    return 0
  fi

  if [ -z "$RSP_HOOK_CACHED_BUNDLE" ] || [ ! -f "$RSP_HOOK_CACHED_BUNDLE" ]; then
    debug "$hook_name fail-open: cached rsp bundle is missing"
    return 0
  fi

  if [ -n "$RSP_HOOK_CACHED_REDDB_BIN" ]; then
    REDDB_BIN="$RSP_HOOK_CACHED_REDDB_BIN" run_bundle "$hook_name"
    rc=$?
  else
    run_bundle "$hook_name"
    rc=$?
  fi

  if [ "$rc" -ne 0 ]; then
    debug "$hook_name fail-open: rsp bundle exited $rc"
    return 0
  fi
  return 0
}

case "${1:-}" in
  prime)
    prime_cache
    ;;
  claude-pre-exec|claude-post-exec|codex-pre-exec|codex-post-exec)
    run_hook "$1"
    ;;
  *)
    drain_stdin
    debug "fail-open: unknown rsp hook mode '${1:-}'"
    ;;
esac

exit 0
