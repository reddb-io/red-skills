#!/usr/bin/env bash
# Fixture-based test for the wiki PR-extract slice (issue #219, PRD #217).
#
# Covers the acceptance grid from the issue brief:
#
#   1. Extraction generates `<wiki>/pages/<pr>-<slug>.md` with the
#      expected frontmatter (type=source, pr=N) and body sections
#      (Summary, Commits, Files changed).
#   2. Idempotency: re-running for the same PR with the SAME title
#      replaces the same file (no duplicate); re-running with a
#      DIFFERENT title removes the prior page and writes the new slug.
#   3. Index regeneration writes `<wiki>/index.md` and lists every page
#      that exists under `pages/`, grouped by type.
#   4. The workflow YAML declares `pull_request.closed`, gates the job
#      with `merged == true`, declares `contents: write`, places the
#      filename under the `red-` prefix, carries the marker commit
#      string `[memory] wiki extract for #`, and never invokes a
#      memory CLI / graph command.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

EXTRACT="scripts/memory-wiki-extract-from-pr.sh"
REGEN="scripts/memory-wiki-regen-index.sh"
WORKFLOW=".github/workflows/red-memory-wiki-extract.yml"
FIX="scripts/fixtures/memory-wiki-extract"

chmod +x "$EXTRACT" "$REGEN"

fail_count=0
pass_count=0
pass() { printf 'PASS  %s\n' "$1"; pass_count=$((pass_count + 1)); }
fail() { printf 'FAIL  %s\n' "$1" >&2; fail_count=$((fail_count + 1)); }

assert_grep() {
  local label="$1" pattern="$2" file="$3"
  if grep -qE "$pattern" "$file"; then
    pass "$label"
  else
    fail "$label — pattern not found: $pattern in $file"
  fi
}

assert_not_grep() {
  local label="$1" pattern="$2" file="$3"
  if grep -qE "$pattern" "$file"; then
    fail "$label — pattern unexpectedly present: $pattern in $file"
  else
    pass "$label"
  fi
}

assert_file_exists() {
  local label="$1" path="$2"
  if [ -f "$path" ]; then pass "$label"; else fail "$label — missing $path"; fi
}

assert_file_absent() {
  local label="$1" path="$2"
  if [ ! -e "$path" ]; then pass "$label"; else fail "$label — unexpectedly present $path"; fi
}

# --- extraction + idempotency ------------------------------------------------

WIKI=$(mktemp -d)
trap 'rm -rf "$WIKI"' EXIT

"$EXTRACT" --pr-number 100 --pr-data "$FIX/pr-100.json" --wiki-root "$WIKI" >/dev/null

PAGE_V1="$WIKI/pages/100-feat-memory-add-closed-loop-wiki-extraction.md"
assert_file_exists "page created with kebab slug" "$PAGE_V1"
assert_grep "frontmatter: type=source"            '^type: source$'              "$PAGE_V1"
assert_grep "frontmatter: pr=100"                 '^pr: 100$'                   "$PAGE_V1"
assert_grep "frontmatter: merge sha recorded"     '^merge_sha: deadbeefcafebabe' "$PAGE_V1"
assert_grep "section: Summary present"            '^## Summary$'                "$PAGE_V1"
assert_grep "section: Commits present"            '^## Commits$'                "$PAGE_V1"
assert_grep "section: Files changed present"      '^## Files changed$'          "$PAGE_V1"
assert_grep "PR body carried through"             'wiki was effectively empty'  "$PAGE_V1"
assert_grep "commit headline listed"              'feat: add workflow'          "$PAGE_V1"
assert_grep "file path listed"                    'red-memory-wiki-extract\.yml' "$PAGE_V1"

# Re-run with SAME title → same path, no duplicate.
"$EXTRACT" --pr-number 100 --pr-data "$FIX/pr-100.json" --wiki-root "$WIKI" >/dev/null
count_same=$(find "$WIKI/pages" -maxdepth 1 -name '100-*.md' | wc -l | tr -d ' ')
if [ "$count_same" = "1" ]; then pass "idempotent re-run (same title): single page"; else fail "idempotent re-run (same title): expected 1 page, got $count_same"; fi

# Re-run with DIFFERENT title → old slug removed, new slug present.
"$EXTRACT" --pr-number 100 --pr-data "$FIX/pr-100-renamed.json" --wiki-root "$WIKI" >/dev/null
PAGE_V2="$WIKI/pages/100-feat-memory-closed-loop-wiki-extraction-renamed.md"
assert_file_absent "renamed: old slug removed" "$PAGE_V1"
assert_file_exists "renamed: new slug present" "$PAGE_V2"
count_after=$(find "$WIKI/pages" -maxdepth 1 -name '100-*.md' | wc -l | tr -d ' ')
if [ "$count_after" = "1" ]; then pass "idempotent re-run (renamed): single page"; else fail "idempotent re-run (renamed): expected 1 page, got $count_after"; fi

# --- index regen -------------------------------------------------------------

"$REGEN" --wiki-root "$WIKI" >/dev/null
INDEX="$WIKI/index.md"
assert_file_exists "index generated"            "$INDEX"
assert_grep "index has Sources section"         '^## Sources$'  "$INDEX"
assert_grep "index lists renamed page"          'feat\(memory\): closed-loop wiki extraction \(renamed\)' "$INDEX"
assert_grep "index links to renamed page slug"  '\./pages/100-feat-memory-closed-loop-wiki-extraction-renamed\.md' "$INDEX"
assert_not_grep "index does not list removed slug" '100-feat-memory-add-closed-loop-wiki-extraction' "$INDEX"

# --- workflow YAML contract --------------------------------------------------

assert_file_exists "workflow file at red- prefix path"      "$WORKFLOW"
assert_grep "workflow triggers on pull_request"             'pull_request:'             "$WORKFLOW"
assert_grep "workflow triggers on closed"                   'types: \[closed\]'         "$WORKFLOW"
assert_grep "workflow gates on merged == true"              "merged == true"            "$WORKFLOW"
assert_grep "workflow declares contents: write"             'contents: write'           "$WORKFLOW"
assert_grep "workflow carries marker commit message"        '\[memory\] wiki extract for #' "$WORKFLOW"
assert_not_grep "workflow does not invoke memory CLI"       '(^|[[:space:]])memory[[:space:]]+(ingest|extract|recall|store)\b' "$WORKFLOW"
assert_not_grep "workflow does not touch graph store"       'graph\.rdb'                "$WORKFLOW"

# --- summary -----------------------------------------------------------------

printf '\n%d passed, %d failed\n' "$pass_count" "$fail_count"
[ "$fail_count" -eq 0 ]
