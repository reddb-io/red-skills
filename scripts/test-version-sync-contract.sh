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

if (( failures > 0 )); then
  printf '\n%d failure(s)\n' "$failures" >&2
  exit 1
fi

printf '\nversion sync contract ok\n'
