#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SKILL="$REPO/plugins/dev/skills/engineering/zoom-out/SKILL.md"
README="$REPO/README.md"
ENGINEERING_INDEX="$REPO/plugins/dev/skills/engineering/README.md"
CLAUDE_PLUGIN="$REPO/plugins/dev/.claude-plugin/plugin.json"
CODEX_PLUGIN="$REPO/plugins/dev/.codex-plugin/plugin.json"
CLAUDE_MARKETPLACE="$REPO/.claude-plugin/marketplace.json"

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

need_regex() {
  local regex="$1" label="$2"
  grep -Eiq -- "$regex" "$SKILL" || fail "zoom-out contract missing $label"
}

need_file_regex() {
  local file="$1" regex="$2" label="$3"
  grep -Eiq -- "$regex" "$file" || fail "$label missing expected text"
}

need_regex 'map-first|map first' 'map-first answer shape'
need_regex 'modules?/layers?' 'modules/layers section'
need_regex 'relationships?' 'relationships section'
need_regex 'critical paths?' 'critical paths section'
need_regex 'risks?/gaps?' 'risks/gaps section'
need_regex 'project glossary|glossary vocabulary|domain glossary' 'project glossary vocabulary'
need_regex 'raw graph|graph dump|nodes/edges' 'raw graph output guardrail'
need_regex 'memory_recall' 'Memory recall invocation'
need_regex 'memory_neighbors' 'Memory graph neighbor invocation'
need_regex 'memory_path' 'Memory graph path invocation'
need_regex 'memory_graph_ready' 'Memory graph readiness check'
need_regex 'memory-bridge\.sh' 'Memory bridge soft-use path'
need_regex 'neighbor.*relationships?|relationships?.*neighbor' 'neighbor evidence strengthens relationships'
need_regex 'path.*critical paths?|critical paths?.*path' 'path evidence strengthens critical paths'
need_regex 'two explicit|explicitly named|from.*to' 'explicit two-element path trigger'
need_regex 'absent|unavailable|uninitialized|no context|no relevant memory|returns no context|returns no result' 'Memory fallback condition'
need_regex 'no path|cannot find.*path|path.*prints nothing|path.*fails' 'path fallback condition'
need_regex 'ordinary codebase exploration|repo exploration|codebase exploration|read the codebase' 'ordinary exploration fallback'
need_regex '/memory:ingest' 'explicit Memory ingest recommendation'
need_regex 'Do not run `/memory:ingest`|never runs? ingest|read-only' 'read-only ingest guardrail'
need_regex 'do not (paste|show|lead with).*(neighbor|node|edge)|interpret.*neighbor' 'raw neighbor output guardrail'
need_regex 'do not (paste|show|lead with).*(path|hop|weight)|interpret.*path' 'raw path output guardrail'

need_file_regex "$README" 'Codebase understanding surface' 'README Codebase understanding docs'
need_file_regex "$README" 'zoom-out.*map-first|map-first.*zoom-out' 'README map-first zoom-out docs'
need_file_regex "$README" 'zoom-out.*Memory Graph|Memory Graph.*zoom-out' 'README graph-aware zoom-out docs'
need_file_regex "$README" 'read-only|does not run `/memory:ingest`|never runs? ingest' 'README read-only graph docs'
need_file_regex "$README" '/memory:ingest' 'README explicit ingest docs'
need_file_regex "$README" 'Memory recall|memory:recall' 'README Memory recall distinction'
need_file_regex "$README" 'Wiki query|wiki query|/wiki query' 'README Wiki query distinction'
need_file_regex "$README" 'future Ask|future `/ask`|Ask surface' 'README future Ask boundary'

need_file_regex "$ENGINEERING_INDEX" 'zoom-out.*map-first|map-first.*zoom-out' 'engineering skill index map-first zoom-out listing'
need_file_regex "$ENGINEERING_INDEX" 'Memory Graph|graph-aware|graph aware' 'engineering skill index graph-aware zoom-out listing'

need_file_regex "$CLAUDE_PLUGIN" 'codebase understanding|graph-aware|graph aware' 'Claude dev plugin metadata'
need_file_regex "$CODEX_PLUGIN" 'codebase understanding|graph-aware|graph aware' 'Codex dev plugin metadata'
need_file_regex "$CLAUDE_MARKETPLACE" 'codebase understanding|graph-aware|graph aware' 'Claude marketplace metadata'

echo "zoom-out contract ok"
