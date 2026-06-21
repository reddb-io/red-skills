#!/usr/bin/env bash
# Lint: every shipped SKILL.md must have its first non-frontmatter, non-heading
# content line begin with a bold span (**…**) — the imperative lead-in convention.
#
# Report-only: always exits 0; findings are informational.
# Skills under in-progress/ are excluded.

set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

failures=0
total=0

while IFS= read -r file; do
  total=$((total + 1))

  # Find the first content line: skip YAML frontmatter (between --- delimiters),
  # heading lines (^#), and blank lines.
  first=$(awk '
    /^---$/ { if (fm==0) {fm=1; next} else if (fm==1) {fm=2; next} }
    fm==1   { next }
    fm==2   { if (/^#/ || /^[[:space:]]*$/) next; print; exit }
    fm==0   { if (/^#/ || /^[[:space:]]*$/) next; print; exit }
  ' "$file")

  if ! printf '%s' "$first" | grep -q "^\*\*"; then
    printf 'FAIL  %s\n' "$file"
    printf '      > %s\n' "$(printf '%s' "$first" | cut -c1-100)"
    failures=$((failures + 1))
  fi
done < <(find plugins -name "SKILL.md" -not -path "*/in-progress/*" | sort)

echo ""
if [ "$failures" -eq 0 ]; then
  echo "lint-skill-first-line: all $total skills have a bold imperative lead-in ✓"
else
  echo "lint-skill-first-line: $failures/$total skills lack a bold imperative lead-in"
  echo "Convention: the first content line (after frontmatter and headings) must start with **bold text**."
fi

exit 0
