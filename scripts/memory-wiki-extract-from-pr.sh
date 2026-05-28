#!/usr/bin/env bash
# Deterministic wiki page generator for a merged PR.
#
# Reads PR data from a JSON file (produced by `gh pr view <n> --json …`) and
# writes a single source-type wiki page at:
#   <wiki-root>/pages/<pr-number>-<slug>.md
#
# Idempotent: removes any existing page matching <pr-number>-*.md before
# writing the new file, so a renamed PR title does not leave a stale page.
#
# Usage:
#   memory-wiki-extract-from-pr.sh \
#     --pr-number <n> \
#     --pr-data <path-to-json> \
#     [--wiki-root <path>]   # default: .red/wiki
#
# Required JSON fields (from `gh pr view`):
#   title, body, author.login, mergeCommit.oid, url,
#   files[].path, commits[].messageHeadline
#
# This script does not call the network and does not touch any graph store.

set -euo pipefail

pr_number=""
pr_data=""
wiki_root=".red/wiki"

while [ $# -gt 0 ]; do
  case "$1" in
    --pr-number) pr_number="$2"; shift 2 ;;
    --pr-data)   pr_data="$2";   shift 2 ;;
    --wiki-root) wiki_root="$2"; shift 2 ;;
    *) printf 'unknown arg: %s\n' "$1" >&2; exit 2 ;;
  esac
done

[ -n "$pr_number" ] || { printf 'error: --pr-number is required\n' >&2; exit 2; }
[ -n "$pr_data" ]   || { printf 'error: --pr-data is required\n' >&2; exit 2; }
[ -f "$pr_data" ]   || { printf 'error: pr-data file %s not found\n' "$pr_data" >&2; exit 2; }

command -v jq >/dev/null || { printf 'error: jq is required\n' >&2; exit 2; }

slugify() {
  # lowercase, replace any run of non-alnum with single '-', trim leading/trailing '-',
  # cap to 60 chars so filenames stay readable
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' \
    | cut -c1-60 \
    | sed -E 's/-+$//'
}

title=$(jq -r '.title // ""' "$pr_data")
body=$(jq -r  '.body  // ""' "$pr_data")
author=$(jq -r '.author.login // "unknown"' "$pr_data")
merge_sha=$(jq -r '.mergeCommit.oid // ""' "$pr_data")
url=$(jq -r '.url // ""' "$pr_data")

slug=$(slugify "$title")
[ -n "$slug" ] || slug="pr-${pr_number}"

pages_dir="${wiki_root}/pages"
mkdir -p "$pages_dir"

# Idempotency: drop any prior page for this PR (covers title/slug changes too).
# Use a literal glob; if nothing matches, the loop body never runs.
shopt -s nullglob
for prior in "${pages_dir}/${pr_number}-"*.md; do
  rm -f "$prior"
done
shopt -u nullglob

page_path="${pages_dir}/${pr_number}-${slug}.md"
today=$(date -u +%Y-%m-%d)

# Compose the page body. Use a temp file so a half-written page cannot
# leave the working tree in a torn state if the script is interrupted.
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

{
  printf -- '---\n'
  printf -- 'title: %s\n' "$title"
  printf -- 'type: source\n'
  printf -- 'tags: [pr, merged]\n'
  printf -- 'created: %s\n' "$today"
  printf -- 'updated: %s\n' "$today"
  printf -- 'sources: [pr-%s]\n' "$pr_number"
  printf -- 'pr: %s\n' "$pr_number"
  printf -- 'merge_sha: %s\n' "$merge_sha"
  printf -- '---\n\n'

  printf -- '# %s\n\n' "$title"
  printf -- '- **PR:** [#%s](%s)\n' "$pr_number" "$url"
  printf -- '- **Author:** @%s\n' "$author"
  printf -- '- **Merge SHA:** `%s`\n' "$merge_sha"
  printf -- '- **Format:** merged pull request\n\n'

  printf -- '## Summary\n\n'
  if [ -n "$body" ]; then
    printf -- '%s\n\n' "$body"
  else
    printf -- '_(PR body was empty.)_\n\n'
  fi

  printf -- '## Commits\n\n'
  commits_count=$(jq -r '.commits // [] | length' "$pr_data")
  if [ "$commits_count" -gt 0 ]; then
    jq -r '.commits[] | "- " + (.messageHeadline // "(no headline)")' "$pr_data"
    printf -- '\n'
  else
    printf -- '_(no commits recorded.)_\n\n'
  fi

  printf -- '## Files changed\n\n'
  files_count=$(jq -r '.files // [] | length' "$pr_data")
  if [ "$files_count" -gt 0 ]; then
    jq -r '.files[] | "- `" + (.path // "?") + "`"' "$pr_data"
    printf -- '\n'
  else
    printf -- '_(no file list recorded.)_\n\n'
  fi
} > "$tmp"

mv "$tmp" "$page_path"
trap - EXIT

printf '%s\n' "$page_path"
