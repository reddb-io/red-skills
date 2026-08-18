#!/usr/bin/env bash
# memory-bridge.sh — dev's soft, optional bridge to the `memory` plugin (issue #57, PRD #49).
#
# The `memory` plugin lives ON TOP of `dev` and improves its processes
# (`/afk` recall, `/triage` dedup, `/diagnose` history). The dependency is
# strictly one-directional: `memory` hard-requires `dev`; `dev` only ever
# *soft-uses* `memory`. So everything here degrades to a SILENT NO-OP — exit 0,
# no output — when memory is absent or uninitialized. `dev` never hard-depends
# on `memory`, and sourcing this file must never change behaviour for a repo
# that has not run `/memory:init`.
#
# Detection has two independent gates, both required:
#   1. the project opted in   — `.red/memory/config.json` exists under the repo root;
#   2. a memory CLI resolves  — via $RED_MEMORY_CLI, a `memory` bin on PATH, a
#      sibling-plugin dist build, or an in-repo checkout.
#
# Source it, then call `memory_available <root>` to gate, `memory_neighbors
# <root> <label>` for focused graph context, `memory_structural_impact <root>
# <file> <symbol>` for graph-derived change impact, `memory_path <root> <from>
# <to>` for relationship paths, `memory_recall <root> <query…>` to fetch a
# ready-to-fold context block (or nothing), or `memory_record_attempt <root>
# <payload-json-file>` to best-effort write an AFK terminal attempt.

# Resolve the memory CLI invocation into the global MEMORY_CLI array.
# Returns 0 and populates MEMORY_CLI on success; returns 1 (MEMORY_CLI empty)
# when no usable CLI is found. Pure resolution — does not execute anything.
_memory_resolve_cli() {
  MEMORY_CLI=()

  # 1. Explicit override — an absolute path to the built cli.js. Highest
  #    priority so a host can pin the exact binary regardless of layout.
  if [[ -n "${RED_MEMORY_CLI:-}" ]]; then
    if [[ -f "${RED_MEMORY_CLI}" ]]; then
      MEMORY_CLI=(node "${RED_MEMORY_CLI}")
      return 0
    fi
    return 1
  fi

  # 2. A `memory` bin on PATH (the plugin's package.json `bin`).
  if command -v memory >/dev/null 2>&1; then
    MEMORY_CLI=(memory)
    return 0
  fi

  # 3. Dynamic-fetch cache bundle. In a real (cache) install there is no built
  #    dist; the memory plugin's bootstrap.mjs (ADR 0029) fetches the bundled CLI
  #    into a version-keyed cache at <runtimeRoot>/<version>/memory-cli.mjs, where
  #    runtimeRoot = <RED_MEMORY_CACHE_DIR | XDG_CACHE_HOME | ~/.cache>/reddb-memory.
  #    Resolve the memory plugin's version from its manifest (sibling of dev or the
  #    in-repo checkout) and use the cached bundle if present.
  local mem_manifest mem_ver runtime_root cache_cli
  for mem_manifest in \
    "${CLAUDE_PLUGIN_ROOT:-}/../memory/.claude-plugin/plugin.json" \
    "${MEMORY_REPO_ROOT:-}/plugins/memory/.claude-plugin/plugin.json"; do
    [[ -f "$mem_manifest" ]] || continue
    mem_ver="$(node -e "process.stdout.write(require(process.argv[1]).version)" "$mem_manifest" 2>/dev/null)"
    [[ -n "$mem_ver" ]] || continue
    runtime_root="${RED_MEMORY_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}}/reddb-memory"
    cache_cli="$runtime_root/$mem_ver/memory-cli.mjs"
    if [[ -f "$cache_cli" ]]; then
      MEMORY_CLI=(node "$cache_cli")
      return 0
    fi
  done

  # 4 & 5. Built dist of a sibling/in-repo memory plugin (dev checkout only).
  #    CLAUDE_PLUGIN_ROOT points at the *dev* plugin when a dev skill runs; the
  #    memory plugin is installed alongside it. MEMORY_REPO_ROOT covers the
  #    in-repo checkout (this monorepo) where both plugins live under plugins/.
  local cand
  for cand in \
    "${CLAUDE_PLUGIN_ROOT:-}/../memory/dist/cli.js" \
    "${MEMORY_REPO_ROOT:-}/plugins/memory/dist/cli.js"; do
    if [[ "$cand" != "/../memory/dist/cli.js" && "$cand" != "/plugins/memory/dist/cli.js" && -f "$cand" ]]; then
      MEMORY_CLI=(node "$cand")
      return 0
    fi
  done

  return 1
}

# memory_available <root> — 0 iff memory is opted-in for <root> AND a CLI resolves.
# <root> defaults to $PWD. Never prints anything.
memory_available() {
  local root="${1:-$PWD}"
  [[ -f "$root/.red/memory/config.json" ]] || return 1
  _memory_resolve_cli || return 1
  return 0
}

# memory_mode <root> — print the configured storage mode, or "unavailable" when
# memory has not been initialized or the config cannot be read. This is a local
# config read only; it does not require the memory CLI.
memory_mode() {
  local root="${1:-$PWD}"
  local config="$root/.red/memory/config.json"
  [[ -f "$config" ]] || {
    printf 'unavailable\n'
    return 0
  }

  local mode
  mode="$(sed -nE 's/.*"mode"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$config" 2>/dev/null | head -n 1)"
  if [[ -n "$mode" ]]; then
    printf '%s\n' "$mode"
  else
    printf 'unavailable\n'
  fi
  return 0
}

# memory_graph_ready <root> — 0 iff memory is configured for graph mode, a CLI
# resolves, and the graph read surface reports at least one node. Never prints
# anything; failures/errors are an absent optimization for dev callers.
memory_graph_ready() {
  local root="${1:-$PWD}"
  [[ "$(memory_mode "$root")" == "graph" ]] || return 1
  _memory_resolve_cli || return 1

  local out nodes
  out="$("${MEMORY_CLI[@]}" stats --root "$root" 2>/dev/null)" || return 1
  nodes="$(printf '%s\n' "$out" | sed -nE 's/^[^0-9]*([0-9]+)[[:space:]]+node\(s\).*/\1/p' | head -n 1)"
  [[ -n "$nodes" && "$nodes" -gt 0 ]] || return 1
  return 0
}

# memory_neighbors <root> <label> [depth] [direction] — print the graph
# neighborhood for a focused label, or nothing. ALWAYS returns 0: absent,
# markdown-only, empty, or erroring graph reads are an optimization miss, not a
# failure of the calling dev process.
memory_neighbors() {
  local root="${1:-$PWD}"
  local label="${2:-}"
  local depth="${3:-1}"
  local direction="${4:-both}"
  [[ -n "$label" ]] || return 0
  memory_graph_ready "$root" || return 0

  local out
  out="$("${MEMORY_CLI[@]}" neighbors "$label" --root "$root" --depth "$depth" --direction "$direction" 2>/dev/null)" || return 0
  [[ -n "$out" ]] || return 0
  printf '%s\n' "$out" | grep -Eq '^memory: 0 neighbor\(s\)' && return 0
  printf '%s\n' "$out"
  return 0
}

# memory_path <root> <from> <to> [algorithm] — print a graph path between two
# focused labels, or nothing. ALWAYS returns 0: absent, markdown-only, no-path,
# empty, or erroring graph reads are an optimization miss, not a failure of the
# calling dev process.
memory_path() {
  local root="${1:-$PWD}"
  local from="${2:-}"
  local to="${3:-}"
  local algorithm="${4:-bfs}"
  [[ -n "$from" && -n "$to" ]] || return 0
  memory_graph_ready "$root" || return 0

  local out
  out="$("${MEMORY_CLI[@]}" path "$from" "$to" --root "$root" --algorithm "$algorithm" 2>/dev/null)" || return 0
  [[ -n "$out" ]] || return 0
  printf '%s\n' "$out" | grep -Eq '^memory: no path from ' && return 0
  printf '%s\n' "$out"
  return 0
}

# memory_structural_impact <root> <file> <symbol> — print graph-derived
# structural impact evidence for a focused file/symbol, or nothing. ALWAYS
# returns 0: absent, markdown-only, empty graph, unknown target, or errors are
# an optimization miss, not a failure of the calling dev process.
memory_structural_impact() {
  local root="${1:-$PWD}"
  local file="${2:-}"
  local symbol="${3:-}"
  [[ -n "$file" || -n "$symbol" ]] || return 0
  memory_graph_ready "$root" || return 0

  local args=()
  [[ -n "$file" ]] && args+=(--file "$file")
  [[ -n "$symbol" ]] && args+=(--symbol "$symbol")

  local out
  out="$("${MEMORY_CLI[@]}" structural-impact --root "$root" "${args[@]}" 2>/dev/null)" || return 0
  [[ -n "$out" ]] || return 0
  printf '%s\n' "$out" | grep -Eq '^memory: no structural impact for ' && return 0
  printf '%s\n' "$out"
  return 0
}

# memory_recall <root> <query…> — print a recall context block for the query,
# or nothing. ALWAYS returns 0: a missing/uninitialized/erroring memory is not a
# failure of the calling dev process, just an absent optimization.
memory_recall() {
  local root="$1"
  shift
  [[ $# -gt 0 ]] || return 0
  memory_available "$root" || return 0
  local out
  out="$("${MEMORY_CLI[@]}" recall "$@" 2>/dev/null)" || return 0
  [[ -n "$out" ]] && printf '%s\n' "$out"
  return 0
}

# memory_record_attempt <root> <payload-json-file> — best-effort write of one
# AFK terminal attempt into graph Memory. ALWAYS returns 0: absent,
# uninitialized, markdown-only, CLI-missing, invalid payload, or write-failing
# Memory must not affect the dev caller's terminal outcome.
memory_record_attempt() {
  local root="${1:-$PWD}"
  local payload_file="${2:-}"
  [[ -f "$payload_file" ]] || return 0
  [[ "$(memory_mode "$root")" == "graph" ]] || return 0
  _memory_resolve_cli || return 0

  if command -v timeout >/dev/null 2>&1; then
    timeout --kill-after=5s 30s "${MEMORY_CLI[@]}" attempt record --root "$root" \
      < "$payload_file" >/dev/null 2>&1 || true
  else
    "${MEMORY_CLI[@]}" attempt record --root "$root" \
      < "$payload_file" >/dev/null 2>&1 || true
  fi
  return 0
}
