#!/usr/bin/env bash
# red-dashboard — launch the RedSkills dashboard tab in Zellij.
#
# The layout runs `$RED_PANE <surface>` in each pane. Zellij's KDL does no path
# resolution, so the ONE thing this launcher exists to do is export that path
# before handing the layout to Zellij — which also means the layout works from
# any cwd, not only from a checkout.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export RED_PANE="${HERE}/red-pane.sh"
LAYOUT="${HERE}/../layouts/red-dashboard.kdl"

if ! command -v zellij >/dev/null 2>&1; then
  printf 'red-dashboard: zellij is not on PATH\n' >&2
  exit 127
fi

# `--layout` with a path takes the file directly; no install step required.
exec zellij --layout "$LAYOUT" "$@"
