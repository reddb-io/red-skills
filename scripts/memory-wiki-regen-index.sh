#!/usr/bin/env bash
# Regenerate <wiki-root>/index.md from <wiki-root>/pages/*.md.
#
# Groups pages by frontmatter `type:` (source | entity | concept | synthesis |
# comparison). Pages without recognised type are bucketed under "Other". Each
# entry is a markdown link to the page with the frontmatter `title:` as the
# display name (falls back to the filename slug).
#
# Idempotent and side-effect-free outside the index file: never edits pages/,
# never mutates raw/.
#
# Usage:
#   memory-wiki-regen-index.sh [--wiki-root <path>]   # default: .red/wiki

set -euo pipefail

wiki_root=".red/wiki"
while [ $# -gt 0 ]; do
  case "$1" in
    --wiki-root) wiki_root="$2"; shift 2 ;;
    *) printf 'unknown arg: %s\n' "$1" >&2; exit 2 ;;
  esac
done

pages_dir="${wiki_root}/pages"
index_path="${wiki_root}/index.md"

mkdir -p "$pages_dir"

# Pull "type|title|slug" from each page; default type = "other".
collect() {
  shopt -s nullglob
  for page in "${pages_dir}"/*.md; do
    slug=$(basename "$page" .md)
    # frontmatter is the block between the first two `---` lines
    type=$(awk 'NR==1 && /^---$/ {f=1; next} f && /^---$/ {exit} f && /^type:[[:space:]]*/ {sub(/^type:[[:space:]]*/, ""); print; exit}' "$page")
    title=$(awk 'NR==1 && /^---$/ {f=1; next} f && /^---$/ {exit} f && /^title:[[:space:]]*/ {sub(/^title:[[:space:]]*/, ""); print; exit}' "$page")
    [ -n "$type" ]  || type="other"
    [ -n "$title" ] || title="$slug"
    printf '%s|%s|%s\n' "$type" "$title" "$slug"
  done
  shopt -u nullglob
}

entries=$(collect)

emit_section() {
  local header="$1" type_key="$2"
  printf '## %s\n\n' "$header"
  local rows
  rows=$(printf '%s\n' "$entries" | awk -F'|' -v t="$type_key" '$1==t {print $2 "|" $3}' | LC_ALL=C sort -t'|' -k1,1)
  if [ -z "$rows" ]; then
    case "$type_key" in
      source)     printf -- '_(no sources yet — merge a PR or run `/wiki ingest <url|path>`)_\n\n' ;;
      entity)     printf -- '_(no entities yet)_\n\n' ;;
      concept)    printf -- '_(no concepts yet)_\n\n' ;;
      synthesis)  printf -- '_(no syntheses yet)_\n\n' ;;
      *)          printf -- '_(none)_\n\n' ;;
    esac
    return
  fi
  printf '%s\n' "$rows" | while IFS='|' read -r title slug; do
    printf -- '- [%s](./pages/%s.md)\n' "$title" "$slug"
  done
  printf '\n'
}

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
{
  printf '# Index\n\n'
  printf 'Wiki catalogue. Regenerated from `pages/` on every ingest.\n\n'
  emit_section 'Sources'    source
  emit_section 'Entities'   entity
  emit_section 'Concepts'   concept
  emit_section 'Syntheses'  synthesis
  # Bucket "comparison" alongside synthesis but only render Other for
  # anything that escaped the recognised set.
  other_rows=$(printf '%s\n' "$entries" | awk -F'|' '$1!="source" && $1!="entity" && $1!="concept" && $1!="synthesis" && $1!="comparison" && NF>0 {print}')
  if [ -n "$other_rows" ]; then
    emit_section 'Other' other
  fi
} > "$tmp"

mv "$tmp" "$index_path"
trap - EXIT

printf '%s\n' "$index_path"
