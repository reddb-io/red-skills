#!/usr/bin/env bash
# red-pane — repaint one RedSkills surface inside a Zellij pane.
#
# A pane is a repaint, not a wait. `monitor`, `dashboard` and `github-spend` are
# one-shot reads by design, so the loop that keeps a pane current belongs HERE,
# at the host edge, rather than as a `--watch` flag inside the engine: a watch
# flag would add a sleep loop to `apps/dev/src`, which is the exact shape the
# declared-wait ratchet refuses.
#
# **Every surface is a local read.** No pane may spend GitHub API budget. A pane
# repaints every few seconds forever, so a single gh-backed surface would drain
# the token's REST pool on its own — which is the failure that empties the queue
# and kills every Worker at boot. `github-spend` reports the host's OWN durable
# attribution; it asks GitHub nothing.
#
# Usage: red-pane.sh <surface>
#   fleet  — per-Worker rows: issue, phase, activity, age  (default)
#   host   — host scope: slots, projects, ready counts, deaths
#   spend  — what this host observed itself spending, all pools
set -uo pipefail

SURFACE="${1:-fleet}"
INTERVAL="${RED_PANE_INTERVAL:-3}"

# Resolve the binaries ONCE, before the loop. A PATH shim is a warm-cache
# optimization and may be a stale pin; the npm direct-run form (ADR 0091) is the
# form that works on a host that installed nothing.
resolve() {
  local binary="$1"
  if command -v "$binary" >/dev/null 2>&1; then
    printf '%s' "$binary"
    return
  fi
  local version="${RED_PANE_VERSION:-}"
  if [[ -z "$version" ]]; then
    # Newest installed plugin cache wins; `latest` only when nothing is installed.
    version="$(ls -1 "$HOME/.claude/plugins/cache/red-skills/dev" 2>/dev/null | sort -V | tail -1)"
    version="${version:-latest}"
  fi
  printf 'npx -y -p @reddb-io/red-skills@%s %s' "$version" "$binary"
}

case "$SURFACE" in
  fleet) CMD="$(resolve red-skills-dev) monitor --plain" ;;
  host)  CMD="$(resolve red-skills-redskilled) dashboard" ;;
  spend) CMD="$(resolve red-skills-redskilled) github-spend --pool all" ;;
  *)
    printf 'red-pane: unknown surface %q (want: fleet, host, spend)\n' "$SURFACE" >&2
    exit 2
    ;;
esac

# `watch` owns the repaint: it clears, redraws, and keeps the pane alive when a
# read fails, so a daemon blip shows the error instead of closing the pane.
# `-c` keeps the surface's colour, `-t` drops the banner so the pane is all data.
exec watch -ct -n "$INTERVAL" -- $CMD
