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
# Source it, then call `memory_available <root>` to gate, or `memory_recall
# <root> <query…>` to fetch a ready-to-fold context block (or nothing).

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

  # 3 & 4. Built dist of a sibling/in-repo memory plugin. CLAUDE_PLUGIN_ROOT
  #    points at the *dev* plugin when a dev skill runs; the memory plugin is
  #    installed alongside it. MEMORY_REPO_ROOT covers the in-repo checkout
  #    (this monorepo) where both plugins live under plugins/.
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
