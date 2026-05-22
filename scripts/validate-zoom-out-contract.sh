#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SKILL="$REPO/plugins/dev/skills/engineering/zoom-out/SKILL.md"

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

need_regex() {
  local regex="$1" label="$2"
  grep -Eiq -- "$regex" "$SKILL" || fail "zoom-out contract missing $label"
}

need_regex 'map-first|map first' 'map-first answer shape'
need_regex 'modules?/layers?' 'modules/layers section'
need_regex 'relationships?' 'relationships section'
need_regex 'critical paths?' 'critical paths section'
need_regex 'risks?/gaps?' 'risks/gaps section'
need_regex 'project glossary|glossary vocabulary|domain glossary' 'project glossary vocabulary'
need_regex 'raw graph|graph dump|nodes/edges' 'raw graph output guardrail'
need_regex 'memory_recall' 'Memory recall invocation'
need_regex 'memory_graph_ready' 'Memory graph readiness check'
need_regex 'memory-bridge\.sh' 'Memory bridge soft-use path'
need_regex 'absent|unavailable|uninitialized|no context|no relevant memory|returns no context|returns no result' 'Memory fallback condition'
need_regex 'ordinary codebase exploration|repo exploration|codebase exploration|read the codebase' 'ordinary exploration fallback'
need_regex '/memory:ingest' 'explicit Memory ingest recommendation'
need_regex 'Do not run `/memory:ingest`|never runs? ingest|read-only' 'read-only ingest guardrail'

echo "zoom-out contract ok"
