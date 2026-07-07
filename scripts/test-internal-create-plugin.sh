#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SCAFFOLDER="plugins/internal/skills/maintainer/create-plugin/scripts/create-plugin.sh"
PLUGIN="fixture-plugin"
OUT=/tmp/.internal-create-plugin-out

[ -f "$SCAFFOLDER" ] || {
  printf 'error: missing scaffolder: %s\n' "$SCAFFOLDER" >&2
  exit 1
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp" "$OUT"' EXIT

cp -R .claude-plugin .agents plugins scripts README.md "$tmp"/

bash "$SCAFFOLDER" --root "$tmp" "$PLUGIN" >"$OUT" 2>&1

grep -Fq "created plugins/$PLUGIN" "$OUT" \
  || {
    printf 'error: scaffolder output did not report created plugin\n' >&2
    cat "$OUT" >&2
    exit 1
  }

jq -e --arg plugin "$PLUGIN" '
  any(.plugins[]; .name == $plugin and .source == ("./plugins/" + $plugin))
' "$tmp/.claude-plugin/marketplace.json" >/dev/null \
  || {
    printf 'error: Claude marketplace entry missing or malformed\n' >&2
    exit 1
  }

jq -e --arg plugin "$PLUGIN" '
  any(.plugins[];
    .name == $plugin
    and .source.source == "local"
    and .source.path == ("./plugins/" + $plugin)
    and .policy.installation == "AVAILABLE"
    and .policy.authentication == "ON_USE"
    and .category == "Developer Tools"
  )
' "$tmp/.agents/plugins/marketplace.json" >/dev/null \
  || {
    printf 'error: Codex marketplace entry missing or malformed\n' >&2
    exit 1
  }

grep -Fq "<what-to-do>" "$tmp/plugins/$PLUGIN/skills/core/$PLUGIN-demo/SKILL.md" \
  || {
    printf 'error: seed skill missing <what-to-do>\n' >&2
    exit 1
  }
grep -Fq "<supporting-info>" "$tmp/plugins/$PLUGIN/skills/core/$PLUGIN-demo/SKILL.md" \
  || {
    printf 'error: seed skill missing <supporting-info>\n' >&2
    exit 1
  }
grep -Fq "Use when" "$tmp/plugins/$PLUGIN/skills/core/$PLUGIN-demo/SKILL.md" \
  || {
    printf 'error: seed skill missing Use when trigger\n' >&2
    exit 1
  }

grep -Fq "**status**: added" "$tmp/plugins/$PLUGIN/CHANGES.md" \
  || {
    printf 'error: generated CHANGES.md missing added status\n' >&2
    exit 1
  }
grep -Fq "**upstream**: none" "$tmp/plugins/$PLUGIN/CHANGES.md" \
  || {
    printf 'error: generated CHANGES.md missing upstream none\n' >&2
    exit 1
  }

bash scripts/validate-marketplace-manifests.sh --root "$tmp"
bash scripts/lint-skill-frontmatter.sh --root "$tmp"
bash "$tmp/plugins/$PLUGIN/scripts/structural-smoke.sh"

echo "internal create-plugin scaffolder acceptance ok"
