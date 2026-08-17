#!/usr/bin/env bash
# Static contract tests for the npm publish ordering in red-publish.yml.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

WORKFLOW=".github/workflows/red-publish.yml"
WORKSPACE_CI=".github/workflows/red-workspace-ci.yml"
failures=0

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  failures=$((failures + 1))
}

pass() {
  printf 'PASS: %s\n' "$*"
}

line_of_step() {
  local step="$1"
  local line
  line="$(grep -nF -- "- name: $step" "$WORKFLOW" | head -n1 | cut -d: -f1 || true)"
  if [ -z "$line" ]; then
    fail "missing release workflow step: $step"
    printf '0\n'
  else
    printf '%s\n' "$line"
  fi
}

assert_before() {
  local left_name="$1" left_line="$2" right_name="$3" right_line="$4"
  if [ "$left_line" -gt 0 ] && [ "$right_line" -gt 0 ] && [ "$left_line" -lt "$right_line" ]; then
    pass "$left_name runs before $right_name"
  else
    fail "$left_name must run before $right_name"
  fi
}

verify_line="$(line_of_step "Verify the tag matches the tree")"
pack_line="$(line_of_step "Pack npm package + producer/consumer contract check")"
publish_line="$(line_of_step "Publish to npm")"
smoke_line="$(line_of_step "Smoke published npm package from registry")"
release_line="$(line_of_step "GitHub Release")"

# ADR 0121: manifest stamping moved OUT of the publish path into the Version
# Packages PR, so the tag arrives with the versions already written. What the
# publish must still prove, in order: the tag agrees with the tree it points at,
# the tarball resolves before it is published, and the GitHub Release is cut
# only after the registry actually serves the version.
assert_before "tag/tree verification" "$verify_line" "pack/contract check" "$pack_line"
assert_before "pack/contract check" "$pack_line" "publish" "$publish_line"
assert_before "publish" "$publish_line" "registry smoke" "$smoke_line"
assert_before "registry smoke" "$smoke_line" "GitHub release" "$release_line"

# That the version surfaces agree with EACH OTHER is the version-train
# invariant, run on every PR by the release engine's own gate. What this
# workflow must still prove is the one thing that invariant cannot see, because
# the tag is not in the tree: the tag names the version the tree carries.
if grep -qF 'tag v${VERSION} points at a tree whose version is ${tree}' "$WORKFLOW"; then
  pass "publish proves the tag names the version the tagged tree carries"
else
  fail "publish must fail a tag whose version disagrees with the tree it points at"
fi

if grep -qF 'tag v${VERSION} points at a tree whose version is' "$WORKFLOW"; then
  pass "a tag that disagrees with the tree fails the publish"
else
  fail "publish must fail when the tag disagrees with the tree's version"
fi

if grep -qF 'HEAD:main' "$WORKFLOW" || grep -qF 'git push origin HEAD' "$WORKFLOW"; then
  fail "the publish workflow must never push a commit to main"
else
  pass "the publish workflow pushes no commit to main"
fi

if grep -qF '::error::NPM_TOKEN secret absent' "$WORKFLOW"; then
  pass "missing NPM_TOKEN is reported as an error"
else
  fail "missing NPM_TOKEN must emit ::error::"
fi

if grep -qF 'skipping npm publish' "$WORKFLOW"; then
  fail "release workflow still skips npm publish when NPM_TOKEN is absent"
else
  pass "missing NPM_TOKEN does not skip publish"
fi

if grep -qF 'npm view "@reddb-io/red-skills@${version}" version' "$WORKFLOW" &&
   grep -qF '[ "$resolved" = "${version}" ]' "$WORKFLOW"; then
  pass "registry smoke resolves the exact published core package version"
else
  fail "registry smoke must resolve the exact core package version from npm"
fi

if grep -qF 'package/dist/$plugin.bundle.min.mjs' "$WORKFLOW" &&
   grep -qF 'npm tarball unexpectedly contains $unexpected' "$WORKFLOW"; then
  pass "pack contract rejects every derived plugin bundle in the core tarball"
else
  fail "pack contract must reject core plugin bundles derived from the plugin tree"
fi

if grep -qF 'test -x "$smoke/node_modules/.bin/red-skills-code-nav"' "$WORKFLOW" &&
   grep -qF 'test -f "$smoke/node_modules/@reddb-io/red-skills/dist/code-nav.bundle.min.mjs"' "$WORKFLOW"; then
  pass "pack contract checks the retained code-nav npm bin and supporting bundle"
else
  fail "pack contract must verify the retained code-nav npm bin and supporting bundle"
fi

if grep -qF 'node scripts/check-npm-tarball-boundaries.mjs' "$WORKFLOW" &&
   grep -qF 'pnpm pi:packages:build' "$WORKFLOW"; then
  pass "publish materialises and checks core plus derived per-plugin tarballs"
else
  fail "publish must check core and every derived per-plugin tarball before publishing"
fi

plugin_publish_line="$(grep -nF 'pnpm pi:packages:publish' "$WORKFLOW" | head -n1 | cut -d: -f1 || true)"
core_publish_line="$(grep -nF 'pnpm publish --access public --no-git-checks' "$WORKFLOW" | head -n1 | cut -d: -f1 || true)"
if [ -n "$plugin_publish_line" ] && [ -n "$core_publish_line" ] &&
   [ "$plugin_publish_line" -lt "$core_publish_line" ]; then
  pass "per-plugin versions publish before the matching core becomes resolvable"
else
  fail "per-plugin packages must publish before core to prevent a mixed release pair"
fi

if grep -qF "find plugins -mindepth 3 -maxdepth 3 -path '*/.claude-plugin/plugin.json'" "$WORKFLOW" &&
   ! grep -qF 'for plugin in dev memory brain' "$WORKFLOW"; then
  pass "per-plugin pack and smoke expectations derive from the plugin tree"
else
  fail "workflow must derive every per-plugin expectation from the plugin tree"
fi

# Exercise the archive boundary checker with real tarballs. The valid fixture
# is assembled from the canonical core package manifest and plugin tree; the
# two mutations specify the failures that must stop a release before npm sees
# any package.
contract_fixture="$(mktemp -d)"
core_tree="$contract_fixture/core-tree/package"
plugin_tarballs="$contract_fixture/plugin-tarballs"
mkdir -p "$core_tree" "$plugin_tarballs"

while IFS= read -r bin_path; do
  mkdir -p "$core_tree/$(dirname "$bin_path")"
  : > "$core_tree/$bin_path"
done < <(node -e "const p=require('./packaging/npm/package.json'); console.log(Object.values(p.bin).join('\\n'))")

for expected in \
  .agents/plugins/marketplace.json \
  .claude-plugin/marketplace.json \
  .gemini-plugin/marketplace.json \
  scripts/generate-codex-manifests.mjs \
  scripts/generate-gemini-manifests.mjs \
  scripts/generate-pi-manifests.mjs; do
  mkdir -p "$core_tree/$(dirname "$expected")"
  : > "$core_tree/$expected"
done
while IFS= read -r bundle; do
  mkdir -p "$core_tree/dist"
  : > "$core_tree/dist/$bundle"
done < <(node -e 'const fs=require("fs");const source=fs.readFileSync("packaging/npm/scripts/prepare.mjs","utf8");for(const match of source.matchAll(/dest:\s*"([^"]+\.bundle\.min\.mjs)"/g))console.log(match[1])')
cp packaging/npm/package.json "$core_tree/package.json"
tar -czf "$contract_fixture/core.tgz" -C "$contract_fixture/core-tree" package

first_plugin=""
while IFS= read -r plugin_json; do
  plugin="$(node -p "require('./${plugin_json}').name")"
  [ -n "$first_plugin" ] || first_plugin="$plugin"
  plugin_tree="$contract_fixture/plugin-$plugin/package"
  mkdir -p "$plugin_tree/skills/core/example" "$plugin_tree/dist"
  : > "$plugin_tree/skills/core/example/SKILL.md"
  : > "$plugin_tree/dist/$plugin.bundle.min.mjs"
  if [ "$plugin" = "memory" ]; then
    : > "$plugin_tree/dist/memory-tokenizer.asset.cjs"
  fi
  tar -czf "$plugin_tarballs/reddb-io-red-skills-$plugin-9.9.9.tgz" \
    -C "$contract_fixture/plugin-$plugin" package
done < <(find plugins -mindepth 3 -maxdepth 3 -path '*/.claude-plugin/plugin.json' -print | sort)

if node scripts/check-npm-tarball-boundaries.mjs \
  --root "$ROOT" \
  --core "$contract_fixture/core.tgz" \
  --plugins "$plugin_tarballs" >/dev/null; then
  pass "materialised tarball listings satisfy both package boundaries"
else
  fail "valid core and per-plugin tarballs must satisfy the publish boundary checker"
fi

memory_tarball="$plugin_tarballs/reddb-io-red-skills-memory-9.9.9.tgz"
tar --exclude='package/dist/memory-tokenizer.asset.cjs' \
  -czf "$memory_tarball" -C "$contract_fixture/plugin-memory" package
if node scripts/check-npm-tarball-boundaries.mjs \
  --root "$ROOT" \
  --core "$contract_fixture/core.tgz" \
  --plugins "$plugin_tarballs" >/dev/null 2>&1; then
  fail "memory plugin tarball without its tokenizer asset must fail the publish contract"
else
  pass "memory plugin tarball without its tokenizer asset fails the publish contract"
fi
tar -czf "$memory_tarball" -C "$contract_fixture/plugin-memory" package

missing_bundle_tree="$contract_fixture/missing-bundle/package"
mkdir -p "$missing_bundle_tree/skills/core/example"
: > "$missing_bundle_tree/skills/core/example/SKILL.md"
tar -czf "$plugin_tarballs/reddb-io-red-skills-$first_plugin-9.9.9.tgz" \
  -C "$contract_fixture/missing-bundle" package
if node scripts/check-npm-tarball-boundaries.mjs \
  --root "$ROOT" \
  --core "$contract_fixture/core.tgz" \
  --plugins "$plugin_tarballs" >/dev/null 2>&1; then
  fail "per-plugin tarball without its runtime bundle must fail the publish contract"
else
  pass "per-plugin tarball without its runtime bundle fails the publish contract"
fi

# Restore the valid per-plugin tarball so this mutation can fail only because
# the core crossed the package boundary, never because of the prior mutation.
plugin_tree="$contract_fixture/plugin-$first_plugin/package"
tar -czf "$plugin_tarballs/reddb-io-red-skills-$first_plugin-9.9.9.tgz" \
  -C "$contract_fixture/plugin-$first_plugin" package

bad_core_tree="$contract_fixture/bad-core/package"
mkdir -p "$contract_fixture/bad-core"
cp -R "$core_tree" "$bad_core_tree"
mkdir -p "$bad_core_tree/dist"
: > "$bad_core_tree/dist/$first_plugin.bundle.min.mjs"
tar -czf "$contract_fixture/bad-core.tgz" -C "$contract_fixture/bad-core" package
if node scripts/check-npm-tarball-boundaries.mjs \
  --root "$ROOT" \
  --core "$contract_fixture/bad-core.tgz" \
  --plugins "$plugin_tarballs" >/dev/null 2>&1; then
  fail "core tarball carrying a per-plugin runtime bundle must fail the publish contract"
else
  pass "core tarball carrying a per-plugin runtime bundle fails the publish contract"
fi

rm -f "$bad_core_tree/dist/$first_plugin.bundle.min.mjs"
: > "$bad_core_tree/dist/memory-tokenizer.asset.cjs"
tar -czf "$contract_fixture/bad-core-tokenizer.tgz" -C "$contract_fixture/bad-core" package
if node scripts/check-npm-tarball-boundaries.mjs \
  --root "$ROOT" \
  --core "$contract_fixture/bad-core-tokenizer.tgz" \
  --plugins "$plugin_tarballs" >/dev/null 2>&1; then
  fail "core tarball carrying the memory tokenizer asset must fail the publish contract"
else
  pass "core tarball carrying the memory tokenizer asset fails the publish contract"
fi
rm -rf "$contract_fixture"

if grep -qF 'registry smoke returned' "$WORKFLOW" &&
   grep -qF '[ "$resolved" = "${version}" ]' "$WORKFLOW"; then
  pass "registry smoke verifies the reported release version"
else
  fail "registry smoke must fail when --version does not report the release version"
fi

if grep -qF 'already on the registry — publish already complete' "$WORKFLOW"; then
  pass "publish is idempotent so a re-run can resume the release tail"
else
  fail "publish must no-op when the version is already on the registry (resumable release tail)"
fi

if grep -q '^  workflow_dispatch:$' "$WORKFLOW" &&
   grep -q '^  schedule:$' "$WORKFLOW" &&
   grep -q 'cron:' "$WORKFLOW"; then
  pass "publish workflow has manual and scheduled retry triggers"
else
  fail "publish workflow must expose workflow_dispatch and schedule retry triggers"
fi

# changesets/action writes its PR through RELEASE_PAT, so GitHub emits the
# normal pull_request event. Keeping a push trigger for that branch would run
# the workspace gate twice for the same Version Packages PR head.
if grep -qF 'branches: [main, automation/toon-bump]' "$WORKSPACE_CI" &&
   ! grep -qF 'changeset-release/main' "$WORKSPACE_CI"; then
  pass "Version Packages PR relies on its PAT-authored pull_request checks"
else
  fail "red-workspace-ci must not duplicate Version Packages PR checks with a push trigger"
fi

# Deferred tags form a FIFO publication queue. Publishing newest-first can move
# npm's latest dist-tag and the moving vX tag backwards on the next retry.
if grep -qF -- "--sort=v:refname" "$WORKFLOW" &&
   ! grep -qF -- "--sort=-v:refname" "$WORKFLOW"; then
  pass "scheduled retries inspect release tags oldest-first"
else
  fail "scheduled retries must inspect release tags oldest-first"
fi

if grep -qF 'oldest incomplete release is $oldest_pending' "$WORKFLOW"; then
  pass "an explicit target cannot jump ahead of the oldest incomplete release"
else
  fail "explicit targets must be rejected when an older release is incomplete"
fi

# Pre-flow tags never had a release tail and can never gain one (their major
# line already moved past them, or has no moving ref at all). They must be
# skipped, not fatal: erroring wedged every publish behind v0.0.1/v1.2.0 (#2460).
if grep -qF 'skipping stale incomplete release' "$WORKFLOW" &&
   ! grep -qF 'refusing stale incomplete release' "$WORKFLOW"; then
  pass "stale incomplete releases are skipped, never fatal"
else
  fail "a stale incomplete release must be skipped by the FIFO scan, not error the run"
fi

# ADR 0121: the tag is the publish trigger. A `push: branches` trigger would put
# the publish back on every commit to main, which is exactly the design this
# replaced.
if grep -qE '^      - "v\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+"$' "$WORKFLOW" &&
   grep -q '^    tags:$' "$WORKFLOW"; then
  pass "publish is triggered by a vX.Y.Z tag push"
else
  fail "publish must trigger on a vX.Y.Z tag push"
fi

if grep -qE '^    branches:' "$WORKFLOW"; then
  fail "publish must not trigger on a branch push"
else
  pass "publish does not trigger on a branch push"
fi

if grep -qF 'release_complete()' "$WORKFLOW" &&
   grep -qF 'major ref already reaches' "$WORKFLOW"; then
  pass "completion requires both the GitHub Release and a reconciled major tag"
else
  fail "a GitHub Release alone must not suppress major-tag reconciliation"
fi

# A moving major ref is an install channel, not necessarily an alias of the
# exact release commit. A hotfix may advance `v2` one commit past `v2.88.0`;
# the FIFO resolver must still recognise that the channel reaches v2.88.0,
# otherwise every historical v2 release becomes pending again and blocks v3.
resolver_fixture="$(mktemp -d)"
trap 'rm -rf "$resolver_fixture"' EXIT

mkdir -p "$resolver_fixture/bin" "$resolver_fixture/repo"
git -C "$resolver_fixture/repo" init -q
git -C "$resolver_fixture/repo" config user.name "Release Contract"
git -C "$resolver_fixture/repo" config user.email "release-contract@example.invalid"

git -C "$resolver_fixture/repo" commit --allow-empty -qm "release v2.88.0"
git -C "$resolver_fixture/repo" tag v2.88.0
git -C "$resolver_fixture/repo" commit --allow-empty -qm "v2 install-channel hotfix"
git -C "$resolver_fixture/repo" tag v2
git -C "$resolver_fixture/repo" switch -qc historical-v3.1.2
git -C "$resolver_fixture/repo" commit --allow-empty -qm "divergent release v3.1.2"
git -C "$resolver_fixture/repo" tag v3.1.2
git -C "$resolver_fixture/repo" switch -q -
git -C "$resolver_fixture/repo" commit --allow-empty -qm "release v3.10.1"
git -C "$resolver_fixture/repo" tag v3.10.1
git -C "$resolver_fixture/repo" tag v3
git -C "$resolver_fixture/repo" commit --allow-empty -qm "release v3.11.0"
git -C "$resolver_fixture/repo" tag v3.11.0

cat > "$resolver_fixture/bin/gh" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "release" ] && [ "${2:-}" = "view" ]; then
  case "${3:-}" in
    v2.88.0 | v3.1.2 | v3.10.1 | v3.11.0) exit 0 ;;
  esac
fi
exit 1
EOF
chmod +x "$resolver_fixture/bin/gh"

awk '
  $0 == "      - name: Resolve the release tag" { in_step = 1; next }
  in_step && $0 == "        run: |" { capture = 1; next }
  capture && /^      - name:/ { exit }
  capture { sub(/^          /, ""); print }
' "$WORKFLOW" > "$resolver_fixture/resolve-release-tag.sh"

if (
  cd "$resolver_fixture/repo"
  PATH="$resolver_fixture/bin:$PATH" \
    EVENT_NAME=workflow_dispatch \
    REF_NAME= \
    INPUT_TAG=v3.11.0 \
    GITHUB_OUTPUT="$resolver_fixture/github-output" \
    bash "$resolver_fixture/resolve-release-tag.sh"
) > "$resolver_fixture/stdout" 2>&1 &&
   grep -q '^publish=true$' "$resolver_fixture/github-output" &&
   grep -q '^tag=v3.11.0$' "$resolver_fixture/github-output"; then
  pass "a moving major ref may carry a descendant hotfix without reopening its release line"
else
  fail "a descendant hotfix on a moving major ref must not block the next release"
fi

# One Release, one owner. The release engine creates it and re-reads the body it
# wrote; a Release created here with generated notes would fail the engine's own
# publish, and the tag push that starts this job is the same event that starts
# the engine's. So this job must hold no `gh release create` at all. Prose
# describing what the Release once did is documentation, not a call: comments
# are stripped before matching.
if sed 's/[[:space:]]*#.*$//' "$WORKFLOW" | grep -qF 'gh release create'; then
  fail "the release engine owns Release creation — this job must only attach assets to it"
else
  pass "this job creates no Release, leaving one owner for the object"
fi

# The release engine owns the Release; this job only attaches to it. A retry
# must therefore converge rather than duplicate — `--clobber` re-uploads what a
# half-finished publish already attached — and must still reconcile the major
# tag, which is the completion marker the retry resolver reads.
if grep -qF 'gh release upload "$NEXT" "${assets[@]}" --clobber' "$WORKFLOW" &&
   grep -qF 'git push --force origin "refs/tags/$major:refs/tags/$major"' "$WORKFLOW"; then
  pass "a retry re-attaches assets and still reconciles the major tag"
else
  fail "asset upload must converge on retry while major-tag reconciliation still runs"
fi

# The standalone installer downloads the RSP bundle into the source snapshot
# used by OpenCode. Building it only for the npm tarball is insufficient: the
# GitHub Release upload list is the installer's public artifact contract.
github_release_step="$(mktemp)"
trap 'rm -f "$github_release_step"' EXIT
awk '
  $0 == "      - name: GitHub Release" { in_step = 1 }
  in_step && /^      - name:/ && $0 != "      - name: GitHub Release" { exit }
  in_step { print }
' "$WORKFLOW" >"$github_release_step"
if grep -qF 'dist/rsp.bundle.min.mjs' "$github_release_step" &&
   grep -qF 'dist/rsp-core.bundle.min.mjs' "$github_release_step"; then
  pass "GitHub Release publishes the RSP launcher and core consumed by the installer"
else
  fail "GitHub Release must upload both RSP boundary assets for standalone installs"
fi

# The fleet-activity deferral was REMOVED (2026-07-22): red-publish never
# touches main and running workers pin their bundle at spawn, so publishing
# during a fleet is safe; the old gate repeatedly held releases hostage to
# orphaned `running` labels.
if ! grep -qF 'Defer if /afk fleet is active' "$WORKFLOW" &&
   ! grep -qF "steps.fleet.outputs.running" "$WORKFLOW"; then
  pass "publish has no fleet-activity deferral gate"
else
  fail "red-publish must not defer on fleet activity — it never touches main"
fi

if grep -qF 'for attempt in 1 2 3 4 5 6 7 8 9 10' "$WORKFLOW" &&
   grep -qF 'sleep $((attempt * 15))' "$WORKFLOW"; then
  pass "registry smoke budget covers multi-minute registry propagation lag"
else
  fail "registry smoke must retry across a multi-minute propagation window (10 attempts, attempt*15s backoff)"
fi

if (( failures > 0 )); then
  printf '\n%d failure(s)\n' "$failures" >&2
  exit 1
fi

printf '\nred-publish npm publish contract ok\n'
