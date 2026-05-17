#!/usr/bin/env bash
# /afk once — supervised single-iteration run. Useful for debugging the prompt
# or trying /afk on a new repo.
#
# Usage: once.sh [project_root]
#
# Equivalent to: afk.sh --once "$@"

set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/afk.sh" --once "$@"
