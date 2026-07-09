#!/usr/bin/env bash
# Report-only lint: SKILL.md body/frontmatter hygiene across every shipped skill.
#
# Findings are printed but the job NEVER fails (always exits 0). It surfaces
# drift toward the house conventions; it does not block unrelated PRs. Skills
# under in-progress/ (drafts) are excluded from every check.
#
# Three checks:
#
#   1. Description discipline (model-invocable skills only). A skill without
#      `disable-model-invocation: true` costs description context in every
#      session, so its frontmatter description must contain the literal
#      substring "Use when" and must stay within the character budget
#      (SKILL_DESC_BUDGET, default 500). Skills that opt out of model
#      invocation are exempt — their description never enters the prompt.
#
#   2. House tags. A SKILL.md whose body (everything after the frontmatter)
#      exceeds SKILL_BODY_LINE_THRESHOLD lines (default 100) must carry a
#      standalone structural `<what-to-do>` tag outside fenced code blocks.
#      Short skills may omit the tags — the threshold encodes that allowance.
#
#   3. Orphaned bundled files. Every non-README markdown file inside a skill
#      folder should be referenced (by basename) from shipped markdown in the
#      same plugin. Cross-skill consumers and extracted sibling reference docs
#      are legitimate, so the reference search is WIDENED to every shipped
#      markdown file in the same plugin (the `plugins/<name>/` ancestor). A
#      file referenced by any other markdown file in its plugin is not flagged.
#      This is the chosen escape mechanism (plugin-wide search rather than an
#      explicit allowlist): it needs no per-file annotation and keeps the wiki
#      templates — consumed by the wiki/wiki-init skills — out of the report.
#
# Config (environment variables):
#   SKILL_DESC_BUDGET          max description length in characters (default 500)
#   SKILL_BODY_LINE_THRESHOLD  body line count that requires <what-to-do> (default 100)
#
# Usage:
#   scripts/lint-skill-body.sh [--root DIR]
# --root overrides the tree swept for plugins/ (default: repo root). Used by
# the bundled fixture tests.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

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

DESC_BUDGET="${SKILL_DESC_BUDGET:-500}"
BODY_LINE_THRESHOLD="${SKILL_BODY_LINE_THRESHOLD:-100}"

if [ ! -d plugins ]; then
  echo "lint-skill-body: no plugins/ directory under $ROOT — nothing to check"
  exit 0
fi

# plugin_root FILE — echo the plugins/<name> ancestor of a path, or empty.
plugin_root() {
  local path="$1"
  case "$path" in
    plugins/*/*)
      # plugins/<name>/...  ->  plugins/<name>
      printf 'plugins/%s' "$(printf '%s' "${path#plugins/}" | cut -d/ -f1)"
      ;;
    *)
      printf ''
      ;;
  esac
}

# has_structural_tag FILE TAG — true when TAG appears as a standalone markdown
# structural line outside fenced code blocks.
has_structural_tag() {
  local file="$1" tag="$2"
  awk -v tag="$tag" '
    /^[[:space:]]*(```|~~~)/ { fence = !fence; next }
    fence { next }
    $0 ~ "^[[:space:]]*" tag "[[:space:]]*$" { found = 1 }
    END { exit found ? 0 : 1 }
  ' "$file"
}

# referenced_in_plugin_markdown FILE PROOT BASENAME — true when BASENAME appears
# in any shipped markdown file in PROOT other than FILE itself.
referenced_in_plugin_markdown() {
  local file="$1" proot="$2" base="$3"
  while IFS= read -r ref; do
    [ "$ref" = "$file" ] && continue
    if grep -qF "$base" "$ref"; then
      return 0
    fi
  done < <(find "$proot" -name '*.md' -not -path '*/in-progress/*' | sort)
  return 1
}

desc_findings=0
tag_findings=0
orphan_findings=0
total_skills=0

echo "== Check 1: description discipline (model-invocable skills) =="
echo "   budget: ${DESC_BUDGET} chars, must contain \"Use when\""
while IFS= read -r file; do
  total_skills=$((total_skills + 1))

  # Extract frontmatter (between the first two --- delimiters).
  fm="$(awk 'NR==1 && $0!="---"{exit} /^---$/{c++; next} c==1{print} c>=2{exit}' "$file")"

  # Skip skills that opt out of model invocation — their description is free.
  if printf '%s\n' "$fm" | grep -Eq '^disable-model-invocation:[[:space:]]*true[[:space:]]*$'; then
    continue
  fi

  desc="$(printf '%s\n' "$fm" | sed -n 's/^description:[[:space:]]*//p' | head -1)"
  if [ -z "$desc" ]; then
    printf 'FAIL  %s\n      > no description in frontmatter\n' "$file"
    desc_findings=$((desc_findings + 1))
    continue
  fi

  len="${#desc}"
  problems=""
  case "$desc" in
    *"Use when"*) : ;;
    *) problems="missing \"Use when\"" ;;
  esac
  if [ "$len" -gt "$DESC_BUDGET" ]; then
    [ -n "$problems" ] && problems="$problems; "
    problems="${problems}over budget (${len} > ${DESC_BUDGET})"
  fi

  if [ -n "$problems" ]; then
    printf 'FAIL  %s\n      > %s\n' "$file" "$problems"
    desc_findings=$((desc_findings + 1))
  fi
done < <(find plugins -name SKILL.md -not -path '*/in-progress/*' | sort)

echo ""
echo "== Check 2: house tags (bodies over ${BODY_LINE_THRESHOLD} lines need <what-to-do>) =="
while IFS= read -r file; do
  # Body = everything after the closing frontmatter delimiter. If there is no
  # frontmatter, the whole file is the body.
  body_lines="$(awk '
    NR==1 && $0=="---" { infm=1; next }
    infm==1 && $0=="---" { infm=0; started=1; next }
    infm==1 { next }
    { count++ }
    END { print count+0 }
  ' "$file")"

  if [ "$body_lines" -gt "$BODY_LINE_THRESHOLD" ]; then
    if ! has_structural_tag "$file" '<what-to-do>'; then
      printf 'FAIL  %s\n      > %s-line body has no <what-to-do> tag\n' "$file" "$body_lines"
      tag_findings=$((tag_findings + 1))
    fi
  fi
done < <(find plugins -name SKILL.md -not -path '*/in-progress/*' | sort)

echo ""
echo "== Check 3: orphaned bundled markdown files =="
echo "   (reference search widened to every shipped markdown file in the same plugin)"
while IFS= read -r file; do
  base="$(basename "$file")"
  proot="$(plugin_root "$file")"
  [ -z "$proot" ] && continue

  # Referenced if any other shipped markdown file in the plugin mentions the basename.
  if referenced_in_plugin_markdown "$file" "$proot" "$base"; then
    continue
  fi

  printf 'FAIL  %s\n      > not referenced by any shipped markdown file in %s\n' "$file" "$proot"
  orphan_findings=$((orphan_findings + 1))
done < <(find plugins -path '*/skills/*' -name '*.md' -not -name SKILL.md -not -name 'README.md' -not -path '*/in-progress/*' | sort)

echo ""
echo "== Summary =="
echo "swept $total_skills shipped SKILL.md files (in-progress/ excluded)"
echo "  description discipline: $desc_findings finding(s)"
echo "  house tags:             $tag_findings finding(s)"
echo "  orphaned bundled files: $orphan_findings finding(s)"
echo "report-only — exiting 0 regardless of findings."

exit 0
