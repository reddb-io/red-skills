#!/usr/bin/env bash
# Blocking audit: shipped SKILL.md frontmatter must stay marketplace-safe.
#
# Rules:
#   1. `name` must equal the skill directory name.
#   2. `description` must be present and non-empty.
#   3. Tool grant fields, when present, must not grant a bare wildcard (`*`).
#   4. `paths`, when present, must be a non-empty list of valid repo-relative globs.
#
# Usage:
#   scripts/lint-skill-frontmatter.sh [--root DIR]

set -uo pipefail

SCRIPT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$SCRIPT_ROOT"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --root)
      ROOT="$2"
      shift 2
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

cd "$ROOT"

if [ ! -d plugins ]; then
  echo "lint-skill-frontmatter: no plugins/ directory under $ROOT - nothing to check"
  exit 0
fi

failures=0
total=0

frontmatter() {
  awk 'NR==1 && $0!="---"{exit} /^---$/{c++; next} c==1{print} c>=2{exit}' "$1"
}

scalar_value() {
  local key="$1"
  sed -n "s/^${key}:[[:space:]]*//p" | head -1 | sed 's/[[:space:]]*#.*$//' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//; s/^"//; s/"$//; s/^'\''//; s/'\''$//'
}

has_non_empty_description() {
  awk '
    /^description:[[:space:]]*$/ { block=1; next }
    /^description:[[:space:]]*[>|-]?/ { found=1; block=1; next }
    /^description:/ {
      value=$0
      sub(/^description:[[:space:]]*/, "", value)
      gsub(/[[:space:]]*#.*$/, "", value)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      if (value != "" && value != "\"\"" && value != "'\'''\''") found=1
      next
    }
    block && /^[[:space:]]+/ {
      value=$0
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      if (value != "") found=1
      next
    }
    block && /^[^[:space:]]/ { block=0 }
    END { exit(found ? 0 : 1) }
  '
}

wildcard_tool_grants() {
  awk '
    function clean(v) {
      sub(/[[:space:]]*#.*/, "", v)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", v)
      gsub(/^["'\''"]|["'\''"]$/, "", v)
      return v
    }
    function isGrantKey(k) {
      return k ~ /^(tools|allowed-tools|allowed_tools|tool-grants|tool_grants)$/
    }
    function isWildcard(v) {
      v=clean(v)
      return v == "*" || v == "[*]" || v == "[\"*\"]" || v == "['\''*'\'']"
    }
    /^[A-Za-z0-9_-]+:/ {
      split($0, parts, ":")
      key=parts[1]
      in_grant=isGrantKey(key)
      value=$0
      sub(/^[^:]+:[[:space:]]*/, "", value)
      if (in_grant && isWildcard(value)) print key
      next
    }
    in_grant && /^[[:space:]]*-[[:space:]]*/ {
      value=$0
      sub(/^[[:space:]]*-[[:space:]]*/, "", value)
      if (isWildcard(value)) print key
    }
  '
}

while IFS= read -r file; do
  total=$((total + 1))
  skill_dir="$(basename "$(dirname "$file")")"
  fm="$(frontmatter "$file")"

  name="$(printf '%s\n' "$fm" | scalar_value name)"
  if [ "$name" != "$skill_dir" ]; then
    printf 'FAIL  %s\n      > name-matches-directory: frontmatter name "%s" must equal directory "%s"\n' "$file" "${name:-<missing>}" "$skill_dir"
    failures=$((failures + 1))
  fi

  if ! printf '%s\n' "$fm" | has_non_empty_description; then
    printf 'FAIL  %s\n      > description-non-empty: frontmatter description must be present and non-empty\n' "$file"
    failures=$((failures + 1))
  fi

  while IFS= read -r grant_key; do
    [ -z "$grant_key" ] && continue
    printf 'FAIL  %s\n      > no-wildcard-tool-grant: %s must not grant bare wildcard "*"\n' "$file" "$grant_key"
    failures=$((failures + 1))
  done < <(printf '%s\n' "$fm" | wildcard_tool_grants)

  if ! paths_error="$(node "$SCRIPT_ROOT/scripts/validate-skill-paths.mjs" "$file" 2>&1)"; then
    printf 'FAIL  %s\n      > paths-globs-valid: %s\n' "$file" "$paths_error"
    failures=$((failures + 1))
  fi
done < <(find plugins -name SKILL.md -not -path '*/in-progress/*' | sort)

echo ""
if [ "$failures" -eq 0 ]; then
  echo "lint-skill-frontmatter: all $total shipped skills passed marketplace frontmatter audit"
else
  echo "lint-skill-frontmatter: $failures finding(s) across $total shipped skills"
fi

exit "$([ "$failures" -eq 0 ] && echo 0 || echo 1)"
