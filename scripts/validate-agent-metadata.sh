#!/usr/bin/env bash
# Validate metadata for packaged Claude Code agents under plugins/<plugin>/agents/.
#
# Claude Code auto-loads subagents from a plugin's `agents/` directory; each
# entry is a markdown file with YAML frontmatter (description, optional tools,
# optional model). See .red/research/197-claude-code-surfaces.md.
#
# Codex CLI does NOT support these subagents today (.red/research/204-…),
# so the Codex plugin manifest must not advertise an `agents` field. The
# Claude marketplace path stays additive — existing skill loading is
# unaffected because we only inspect a separate `agents/` directory.
#
# Usage:
#   scripts/validate-agent-metadata.sh [--root <repo>] [<plugin-dir> …]
#
# With no plugin args, defaults to plugins/*. Plugin args may be absolute or
# repo-relative directories. Exits non-zero on the first failure.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
declare -a PLUGIN_DIRS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --root)
      ROOT="$2"
      shift 2
      ;;
    --root=*)
      ROOT="${1#--root=}"
      shift
      ;;
    -h|--help)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    *)
      PLUGIN_DIRS+=("$1")
      shift
      ;;
  esac
done

cd "$ROOT"

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

if [ "${#PLUGIN_DIRS[@]}" -eq 0 ]; then
  for d in plugins/*/; do
    [ -d "$d" ] || continue
    PLUGIN_DIRS+=("${d%/}")
  done
fi

validate_agent_file() {
  local file="$1"
  local first
  first="$(head -n 1 "$file" || true)"
  [ "$first" = "---" ] \
    || fail "$file: must start with YAML frontmatter (---) on line 1"

  # extract the block between the first two `---` lines
  local frontmatter
  frontmatter="$(awk 'NR==1 && $0=="---"{flag=1; next} flag && $0=="---"{exit} flag' "$file")"
  [ -n "$frontmatter" ] \
    || fail "$file: empty or unterminated YAML frontmatter"

  printf '%s\n' "$frontmatter" \
    | grep -Eq '^description:[[:space:]]*[^[:space:]].*$' \
    || fail "$file: frontmatter must declare a non-empty 'description:'"

  # forbid keys we know are not part of the Claude subagent schema, to catch
  # typos before they silently disable an agent.
  local bad
  bad="$(printf '%s\n' "$frontmatter" \
    | awk -F: '/^[a-zA-Z_-]+:/{print $1}' \
    | grep -Ev '^(description|tools|model|name|allowed-tools|disable-model-invocation)$' \
    || true)"
  if [ -n "$bad" ]; then
    fail "$file: unknown frontmatter key(s): $(printf '%s ' $bad)"
  fi
}

validate_plugin_agents() {
  local plugin_dir="$1"
  local agents_dir="$plugin_dir/agents"

  if [ -d "$agents_dir" ]; then
    local any=0
    while IFS= read -r -d '' f; do
      any=1
      validate_agent_file "$f"
    done < <(find "$agents_dir" -maxdepth 1 -type f -name '*.md' -print0)
    [ "$any" -eq 1 ] \
      || fail "$plugin_dir: agents/ exists but is empty (remove the dir or add agents)"
  fi

  local codex_manifest="$plugin_dir/.codex-plugin/plugin.json"
  if [ -f "$codex_manifest" ]; then
    jq -e 'has("agents") | not' "$codex_manifest" >/dev/null \
      || fail "$codex_manifest: Codex plugin must not declare 'agents' (Claude-only surface; see .red/research/204-…)"
  fi

  if [ "$(basename "$plugin_dir")" = "dev" ]; then
    validate_dev_tier_agents "$plugin_dir"
  fi
}

frontmatter_value() {
  local file="$1"
  local key="$2"
  awk -F: -v key="$key" '
    NR == 1 && $0 == "---" { in_frontmatter = 1; next }
    in_frontmatter && $0 == "---" { exit }
    in_frontmatter && $1 == key {
      sub(/^[[:space:]]+/, "", $2)
      sub(/[[:space:]]+$/, "", $2)
      print $2
      exit
    }
  ' "$file"
}

require_agent() {
  local plugin_dir="$1"
  local file_name="$2"
  local model="$3"
  local effort="$4"
  local file="$plugin_dir/agents/$file_name"

  [ -f "$file" ] || fail "$plugin_dir: missing required tier agent agents/$file_name"
  [ "$(frontmatter_value "$file" model)" = "$model" ] \
    || fail "$file: model frontmatter must be '$model'"
  grep -Eq "effort:[[:space:]]*$effort" "$file" \
    || fail "$file: body must carry the '$effort' effort prompt convention"
}

validate_dev_tier_agents() {
  local plugin_dir="$1"

  require_agent "$plugin_dir" validate.md haiku low
  require_agent "$plugin_dir" simple-code.md sonnet high
  require_agent "$plugin_dir" complex-code.md opus medium
}

for plugin_dir in "${PLUGIN_DIRS[@]}"; do
  [ -d "$plugin_dir" ] || fail "not a directory: $plugin_dir"
  validate_plugin_agents "$plugin_dir"
done

echo "agent metadata ok"
