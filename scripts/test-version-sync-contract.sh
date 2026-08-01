#!/usr/bin/env bash
# Contract tests for scripts/sync-version.mjs — the ADR 0040 single writer that
# carries the changesets-decided version into every file changesets does not own.
#
# The drift class this pins: `changeset version` bumps apps/dev/package.json but
# leaves plugins/dev/.claude-plugin/plugin.json at the previous number, and the
# release ships manifests that disagree with the published bundle.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SCRIPT="scripts/sync-version.mjs"
failures=0

fail() { printf 'FAIL: %s\n' "$*" >&2; failures=$((failures + 1)); }
pass() { printf 'PASS: %s\n' "$*"; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Work on a throwaway copy so the test never mutates the checkout.
fixture="$TMP/repo"
mkdir -p "$fixture"
git ls-files -z \
  package.json \
  'apps/dev/package.json' \
  'plugins/*/package.json' \
  'plugins/*/.claude-plugin/plugin.json' \
  'plugins/*/.codex-plugin/plugin.json' \
  'plugins/*/.gemini-plugin/plugin.json' \
  'packaging/pi/*/package.json' \
  | xargs -0 -I{} sh -c 'mkdir -p "$1/$(dirname "{}")" && cp "{}" "$1/{}"' _ "$fixture"
mkdir -p "$fixture/scripts"
cp "$SCRIPT" "$fixture/scripts/"

version_of() { node -e "console.log(require('$1').version)"; }

# --- the checkout itself must be in sync -----------------------------------

if node "$SCRIPT" --check >/dev/null 2>&1; then
  pass "the committed checkout has no version drift"
else
  fail "the committed checkout has version drift (run \`pnpm version:sync\`)"
  node "$SCRIPT" --check || true
fi

# --- --check detects drift --------------------------------------------------

drifted="$fixture/plugins/dev/.claude-plugin/plugin.json"
node -e "
const fs=require('fs');
const j=JSON.parse(fs.readFileSync('$drifted','utf8'));
j.version='0.0.1-drifted';
fs.writeFileSync('$drifted', JSON.stringify(j,null,2)+'\n');
"
if (cd "$fixture" && node scripts/sync-version.mjs --check >/dev/null 2>&1); then
  fail "--check must exit non-zero when a plugin manifest drifts"
else
  pass "--check fails on a drifted plugin manifest"
fi

if (cd "$fixture" && node scripts/sync-version.mjs --check 2>&1 || true) |
   grep -qF 'plugins/dev/.claude-plugin/plugin.json'; then
  pass "--check names the drifted file"
else
  fail "--check must name the drifted file"
fi

# --- the writer repairs drift ----------------------------------------------

expected="$(version_of "$fixture/apps/dev/package.json")"
(cd "$fixture" && node scripts/sync-version.mjs >/dev/null)
if [ "$(version_of "$drifted")" = "$expected" ]; then
  pass "the writer repairs a drifted manifest from the apps/dev anchor"
else
  fail "the writer must rewrite a drifted manifest to $expected"
fi
if (cd "$fixture" && node scripts/sync-version.mjs --check >/dev/null 2>&1); then
  pass "--check passes after the writer runs"
else
  fail "--check must pass after the writer runs"
fi

# --- an explicit version propagates everywhere ------------------------------

(cd "$fixture" && node scripts/sync-version.mjs --version 9.9.9 >/dev/null)
missed=0
while IFS= read -r file; do
  [ -f "$fixture/$file" ] || continue
  if [ "$(version_of "$fixture/$file")" != "9.9.9" ]; then
    fail "--version 9.9.9 did not reach $file"
    missed=1
  fi
done <<'FILES'
package.json
plugins/dev/package.json
plugins/memory/package.json
plugins/brain/package.json
plugins/dev/.claude-plugin/plugin.json
plugins/dev/.codex-plugin/plugin.json
plugins/dev/.gemini-plugin/plugin.json
plugins/memory/.claude-plugin/plugin.json
plugins/memory/.codex-plugin/plugin.json
plugins/memory/.gemini-plugin/plugin.json
plugins/brain/.claude-plugin/plugin.json
plugins/brain/.codex-plugin/plugin.json
plugins/brain/.gemini-plugin/plugin.json
packaging/pi/dev/package.json
packaging/pi/memory/package.json
packaging/pi/brain/package.json
FILES
[ "$missed" -eq 0 ] && pass "--version reaches every version-bearing file"

# A leading `v` (the tag shape) is accepted and stripped.
(cd "$fixture" && node scripts/sync-version.mjs --version v9.9.10 >/dev/null)
if [ "$(version_of "$fixture/package.json")" = "9.9.10" ]; then
  pass "a vX.Y.Z tag argument is normalised to X.Y.Z"
else
  fail "a vX.Y.Z tag argument must be normalised to X.Y.Z"
fi

# --- garbage input is rejected, not written --------------------------------

if (cd "$fixture" && node scripts/sync-version.mjs --version "not-a-version" >/dev/null 2>&1); then
  fail "an invalid version must be rejected"
else
  pass "an invalid version is rejected before anything is written"
fi
if [ "$(version_of "$fixture/package.json")" = "9.9.10" ]; then
  pass "a rejected version leaves the files untouched"
else
  fail "a rejected version must not partially write"
fi

# --- the retired direct-push machinery stays retired ------------------------

for retired in \
  scripts/release-push-bump.sh \
  scripts/test-red-release-bump-push-contract.sh \
  scripts/decide-release-bump-kind.mjs \
  scripts/test-red-release-bump-kind.sh; do
  if [ -e "$ROOT/$retired" ]; then
    fail "$retired must be deleted — the changesets flow replaced it"
  else
    pass "$retired is gone"
  fi
done

# Match the retired token being USED by the release flow, not the word appearing
# in prose. The Version Packages PR deliberately uses RELEASE_PAT so GitHub
# treats its pull_request checks like those from a maintainer-authored PR.
release_workflows=(
  .github/workflows/red-release.yml
  .github/workflows/red-publish.yml
)
if grep -nE 'secrets\.RED_RELEASE_TOKEN|\$\{?RED_RELEASE_TOKEN' \
     "${release_workflows[@]}" >/dev/null 2>&1; then
  fail "the retired RED_RELEASE_TOKEN must not survive in the release workflows"
  grep -nE 'secrets\.RED_RELEASE_TOKEN|\$\{?RED_RELEASE_TOKEN' \
    "${release_workflows[@]}" >&2 || true
else
  pass "no RED_RELEASE_TOKEN path survives in the release flow"
fi

# --- the version workflow proposes, it never pushes -------------------------

RELEASE_WORKFLOW=".github/workflows/red-release.yml"

if grep -qF 'changesets/action@' "$RELEASE_WORKFLOW"; then
  pass "the version workflow maintains the Version Packages PR with changesets/action"
else
  fail "the version workflow must use changesets/action to maintain the Version Packages PR"
fi

if grep -qF 'version: pnpm release:version' "$RELEASE_WORKFLOW"; then
  pass "changesets/action versions through pnpm release:version (changeset version + sync)"
else
  fail "changesets/action must version through pnpm release:version so the manifest sync runs"
fi

if grep -qF 'GITHUB_TOKEN: ${{ secrets.RELEASE_PAT }}' "$RELEASE_WORKFLOW"; then
  pass "changesets/action uses RELEASE_PAT so Version Packages PR checks start automatically"
else
  fail "changesets/action must use secrets.RELEASE_PAT for the Version Packages PR"
fi

# The whole point of the migration: main is written by merged PRs only.
if grep -qE 'git push [^ ]* HEAD:(main|\$\{?BASE)' "$RELEASE_WORKFLOW"; then
  fail "the version workflow must never push a commit to main"
else
  pass "the version workflow pushes no commit to main"
fi

if grep -qF 'pnpm version:sync:check' "$RELEASE_WORKFLOW"; then
  pass "the version workflow refuses to propose a bump on a drifted checkout"
else
  fail "the version workflow must run pnpm version:sync:check before versioning"
fi

if grep -qF 'gh workflow run red-publish.yml' "$RELEASE_WORKFLOW"; then
  pass "the cut hands off to red-publish (a GITHUB_TOKEN tag push cannot trigger it)"
else
  fail "the cut must dispatch red-publish.yml explicitly"
fi

# --- the cut targets the bump commit, not the tree that raced past it -------

# Two tags were swallowed on 2026-08-01: the cut read `.changeset/` and the
# version out of the CURRENT checkout, so a merge landing between the Version
# Packages PR merge and this run made the bump look un-merged. The tag target is
# the bump commit the push event named, and the run is exercised here for real
# against a repository where a later commit already moved main past it.

CUT="scripts/release-cut-tag.sh"

if [ -x "$ROOT/$CUT" ]; then
  pass "the release cut is an executable script the contract can run"
else
  fail "$CUT must exist and be executable"
fi

# Build: commit A (1.0.0, one pending changeset) → commit B, the bump (1.1.0, no
# changesets) → commit C, a merge racing in behind it (2.0.0 + a new changeset).
# Reading anything from the working tree yields C's answers, and every one of
# them is wrong.
cut_repo="$TMP/cut"
bump_sha=""
race_sha=""
if [ -x "$ROOT/$CUT" ]; then
  (
    set -e
    mkdir -p "$cut_repo"
    git init -q --bare "$cut_repo/remote.git"
    git init -q -b main "$cut_repo/work"
    cd "$cut_repo/work"
    git config user.email 'contract@example.invalid'
    git config user.name 'contract'
    mkdir -p .changeset
    printf 'changesets readme\n' > .changeset/README.md
    printf '{\n  "version": "1.0.0"\n}\n' > package.json
    printf -- '---\n"@scope/pkg": minor\n---\n\nfeature a\n' > .changeset/feature-a.md
    git add -A && git commit -qm 'feat: a'
    printf '{\n  "version": "1.1.0"\n}\n' > package.json
    git rm -q .changeset/feature-a.md
    git commit -qam 'chore(release): version packages'
    git rev-parse HEAD > "$cut_repo/bump.sha"
    printf '{\n  "version": "2.0.0"\n}\n' > package.json
    printf -- '---\n"@scope/pkg": major\n---\n\nfeature b\n' > .changeset/feature-b.md
    git add -A && git commit -qm 'feat: b (raced in behind the bump)'
    git rev-parse HEAD > "$cut_repo/race.sha"
    git remote add origin "$cut_repo/remote.git"
    git push -q origin main
  ) || fail "could not build the release-cut fixture repository"
  bump_sha="$(cat "$cut_repo/bump.sha" 2>/dev/null || true)"
  race_sha="$(cat "$cut_repo/race.sha" 2>/dev/null || true)"
fi

run_cut() {
  local sha="$1" out="$2"
  : > "$out"
  (cd "$cut_repo/work" && BUMP_SHA="$sha" GITHUB_OUTPUT="$out" \
    bash "$ROOT/$CUT" 2>&1)
}

if [ -n "$bump_sha" ] && [ -n "$race_sha" ]; then
  cut_log="$TMP/cut.log"
  cut_out="$TMP/cut.out"
  if run_cut "$bump_sha" "$cut_out" > "$cut_log" 2>&1; then
    pass "the cut runs green against a main that already moved past the bump"
  else
    fail "the cut failed against a main that moved past the bump"
    cat "$cut_log" >&2 || true
  fi

  tagged="$(git -C "$cut_repo/work" rev-list -n1 v1.1.0 2>/dev/null || true)"
  if [ "$tagged" = "$bump_sha" ]; then
    pass "the tag targets the bump commit sha, not the tip that raced past it"
  else
    fail "the tag must target the bump commit ($bump_sha), got '${tagged:-<no tag>}'"
  fi

  if [ -z "$(git -C "$cut_repo/work" tag -l v2.0.0)" ]; then
    pass "the version comes from the bump commit's tree, not the working tree"
  else
    fail "the cut read the version out of the working tree (tagged v2.0.0)"
  fi

  pushed="$(git -C "$cut_repo/remote.git" rev-parse -q --verify 'refs/tags/v1.1.0^{commit}' 2>/dev/null || true)"
  if [ "$pushed" = "$bump_sha" ]; then
    pass "the cut pushes the tag at the bump commit to the remote"
  else
    fail "the remote must carry v1.1.0 at the bump commit, got '${pushed:-<nothing>}'"
  fi

  if grep -qF 'tag=v1.1.0' "$cut_out"; then
    pass "the cut reports the tag it cut through GITHUB_OUTPUT"
  else
    fail "the cut must write tag=v1.1.0 to GITHUB_OUTPUT so the publish dispatch fires"
  fi

  if grep -qF '::notice::' "$cut_log" && grep -qF 'v1.1.0' "$cut_log"; then
    pass "a completed cut announces the tag as a workflow notice"
  else
    fail "the cut must announce the tag it cut with ::notice::"
  fi

  # A run whose commit still carries changesets did not cut — and must say why.
  race_log="$TMP/cut-race.log"
  if run_cut "$race_sha" "$TMP/cut-race.out" > "$race_log" 2>&1; then
    pass "a commit with pending changesets exits clean instead of erroring"
  else
    fail "a commit with pending changesets must not fail the workflow"
  fi
  if grep -qF '::notice::' "$race_log" && grep -qiF 'changeset' "$race_log"; then
    pass "a skipped cut names pending changesets as its reason"
  else
    fail "a skip for pending changesets must print a ::notice:: naming the reason"
    cat "$race_log" >&2 || true
  fi
  if [ -z "$(git -C "$cut_repo/work" tag -l v2.0.0)" ]; then
    pass "no tag is cut while changesets are still pending at that commit"
  else
    fail "the cut must not tag a commit that still carries changesets"
  fi

  # Re-running the same push (a re-dispatch, a retried job) is a skip, not a
  # second tag and not a failure.
  again_log="$TMP/cut-again.log"
  if run_cut "$bump_sha" "$TMP/cut-again.out" > "$again_log" 2>&1; then
    pass "re-cutting an already-tagged bump commit exits clean"
  else
    fail "re-cutting an already-tagged bump commit must not fail the workflow"
  fi
  if grep -qF '::notice::' "$again_log" && grep -qF 'v1.1.0' "$again_log"; then
    pass "an already-tagged cut says so instead of going silent"
  else
    fail "an already-cut tag must print a ::notice:: naming the existing tag"
  fi

  # A missing/absent sha is a broken run, not a quiet no-op.
  miss_log="$TMP/cut-missing.log"
  if run_cut "" "$TMP/cut-missing.out" > "$miss_log" 2>&1; then
    fail "an empty BUMP_SHA must fail the cut loudly"
  else
    pass "an empty BUMP_SHA fails the cut instead of skipping silently"
  fi
  if grep -qF '::error::' "$miss_log"; then
    pass "a broken cut reports itself as a workflow error"
  else
    fail "a broken cut must print ::error:: naming the problem"
  fi
fi

# --- the workflow hands the cut the event's own sha -------------------------

if grep -qF 'BUMP_SHA: ${{ github.sha }}' "$RELEASE_WORKFLOW"; then
  pass "the workflow carries the pushed bump commit sha into the cut"
else
  fail "the cut must receive BUMP_SHA: \${{ github.sha }} from the push event payload"
fi

if grep -qF 'scripts/release-cut-tag.sh' "$RELEASE_WORKFLOW"; then
  pass "the workflow cuts through the contract-tested script"
else
  fail "the workflow must cut the tag through scripts/release-cut-tag.sh"
fi

if grep -qE '^\s*git tag ' "$RELEASE_WORKFLOW"; then
  fail "the workflow must not tag inline — the cut logic belongs in the tested script"
else
  pass "the workflow holds no inline tagging logic"
fi

# The live changesets state is exactly what a racing merge rewrites; gating the
# step on it is how the two swallowed tags happened.
if grep -qF "hasChangesets == 'false'" "$RELEASE_WORKFLOW"; then
  fail "the cut must not be gated on the live hasChangesets output — a racing merge rewrites it"
else
  pass "the cut decides from the bump commit, not from the live changesets state"
fi

if (( failures > 0 )); then
  printf '\n%d failure(s)\n' "$failures" >&2
  exit 1
fi

printf '\nversion sync contract ok\n'
