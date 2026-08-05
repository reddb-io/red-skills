#!/usr/bin/env bash
# Contract tests for scripts/validate-changesets.mjs — the PR-time check that a
# pending changeset actually resolves against this workspace (#2863).
#
# The outage this pins: one changeset said `"red-skills"` (the ROOT manifest's
# name, which is not a workspace package) where every other one says
# `"@reddb-io/red-skills"`. The release engine rejects that unresolved intent;
# this catches it while the contributor PR is still open.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SCRIPT="$ROOT/scripts/validate-changesets.mjs"
failures=0

fail() { printf 'FAIL: %s\n' "$*" >&2; failures=$((failures + 1)); }
pass() { printf 'PASS: %s\n' "$*"; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# A throwaway workspace with the same shape as this repo: two package roots, a
# scoped package name, and a root manifest whose name is NOT a workspace member.
new_fixture() {
  local dir="$TMP/$1"
  mkdir -p "$dir/.changeset" "$dir/apps/dev" "$dir/apps/bundle" "$dir/packages/shared"
  cat > "$dir/pnpm-workspace.yaml" <<'YAML'
packages:
  - "apps/*"
  - "packages/*"

catalog:
  typescript: ^5.6.0
YAML
  printf '{"name":"red-skills","private":true}\n' > "$dir/package.json"
  printf '{"name":"@reddb-io/dev"}\n' > "$dir/apps/dev/package.json"
  printf '{"name":"@reddb-io/red-skills"}\n' > "$dir/apps/bundle/package.json"
  printf '{"name":"@reddb-io/shared"}\n' > "$dir/packages/shared/package.json"
  printf 'Changesets live here.\n' > "$dir/.changeset/README.md"
  printf '%s' "$dir"
}

changeset() { # <fixture-dir> <name> <frontmatter-body>
  { printf -- '---\n%s\n---\n\nA summary line.\n' "$3"; } > "$1/.changeset/$2.md"
}

run_on() { # <fixture-dir> -> stdout+stderr, exit code preserved by caller
  node "$SCRIPT" --root "$1" 2>&1
}

# --- the committed checkout resolves ---------------------------------------

if node "$SCRIPT" >/dev/null 2>&1; then
  pass "every changeset committed in this checkout resolves against the workspace"
else
  fail "this checkout carries a changeset that cannot resolve — the release would abort"
  node "$SCRIPT" || true
fi

# --- a valid changeset passes ----------------------------------------------

good="$(new_fixture good)"
changeset "$good" "a-real-slice" '"@reddb-io/dev": patch'
if node "$SCRIPT" --root "$good" >/dev/null 2>&1; then
  pass "a changeset naming a workspace package passes"
else
  fail "a valid changeset must pass"
  run_on "$good" || true
fi

# Several packages and every accepted bump, in one file.
changeset "$good" "a-wide-slice" '"@reddb-io/dev": minor
"@reddb-io/shared": none'
if node "$SCRIPT" --root "$good" >/dev/null 2>&1; then
  pass "a multi-package changeset with major/minor/patch/none bumps passes"
else
  fail "every bump changesets accepts (including \`none\`) must pass"
  run_on "$good" || true
fi

# An empty frontmatter block is a valid changeset that releases nothing.
changeset "$good" "an-empty-one" ''
if node "$SCRIPT" --root "$good" >/dev/null 2>&1; then
  pass "a changeset with an empty frontmatter block passes"
else
  fail "an empty changeset releases nothing and must not be rejected"
  run_on "$good" || true
fi

# --- an unknown package name fails -----------------------------------------

bad="$(new_fixture bad)"
changeset "$bad" "names-a-stranger" '"@reddb-io/nowhere": patch'
if node "$SCRIPT" --root "$bad" >/dev/null 2>&1; then
  fail "a changeset naming a package outside the workspace must exit non-zero"
else
  pass "a changeset naming a package outside the workspace exits non-zero"
fi

out="$(run_on "$bad" || true)"
if grep -qF 'names-a-stranger.md' <<<"$out"; then
  pass "the failure names the offending changeset file"
else
  fail "the failure must name the offending file"
  printf '%s\n' "$out" >&2
fi
if grep -qF '@reddb-io/nowhere' <<<"$out"; then
  pass "the failure names the unknown package"
else
  fail "the failure must name the unknown package"
  printf '%s\n' "$out" >&2
fi

# --- the exact outage: the ROOT manifest's name is not a workspace package ---

incident="$(new_fixture incident)"
changeset "$incident" "gemini-cli-integration" '"red-skills": minor'
if node "$SCRIPT" --root "$incident" >/dev/null 2>&1; then
  fail "the root manifest's name is not a workspace package — it must be rejected"
else
  pass "the root manifest's name is rejected exactly as \`changeset version\` rejects it"
fi

out="$(run_on "$incident" || true)"
if grep -qF 'did you mean "@reddb-io/red-skills"' <<<"$out"; then
  pass "the failure points at the scoped workspace name the author meant"
else
  fail "an unknown name matching exactly one scoped package must suggest that package"
  printf '%s\n' "$out" >&2
fi

# Ambiguity must not become a confident wrong answer.
ambiguous="$(new_fixture ambiguous)"
printf '{"name":"@other/dev"}\n' > "$ambiguous/packages/shared/package.json"
changeset "$ambiguous" "ambiguous-suffix" '"dev": patch'
if grep -qF 'did you mean' <<<"$(run_on "$ambiguous" || true)"; then
  fail "two packages ending in /dev must yield no suggestion, not a guess"
else
  pass "an ambiguous suffix yields no suggestion rather than a wrong one"
fi

# --- an unrecognized bump fails --------------------------------------------

bump="$(new_fixture bump)"
changeset "$bump" "typoed-bump" '"@reddb-io/dev": pathc'
if node "$SCRIPT" --root "$bump" >/dev/null 2>&1; then
  fail "an unrecognized bump aborts the same release plan and must be rejected"
else
  pass "an unrecognized bump is rejected"
fi
if grep -qF 'pathc' <<<"$(run_on "$bump" || true)"; then
  pass "the failure names the unrecognized bump"
else
  fail "the failure must name the unrecognized bump"
fi

# --- no pending changesets passes, it does not error ------------------------

empty="$(new_fixture empty)"
if node "$SCRIPT" --root "$empty" >/dev/null 2>&1; then
  pass "a repository whose .changeset holds only README/config passes"
else
  fail "no pending changesets must pass, not error"
  run_on "$empty" || true
fi

none="$(new_fixture none)"
rm -rf "$none/.changeset"
if node "$SCRIPT" --root "$none" >/dev/null 2>&1; then
  pass "a repository with no .changeset directory at all passes"
else
  fail "a repository with no .changeset directory must pass, not error"
  run_on "$none" || true
fi

# --- the check is wired into the PR gate ------------------------------------
#
# `.changeset/` is classified INERT by scripts/ci-affected-scope.mjs, so a
# changeset-only PR runs neither the test nor the typecheck job. The check has to
# live in a job that runs unconditionally or it would never see the PR that
# carries the defect.

CI=".github/workflows/red-workspace-ci.yml"

# The body of the one job that runs unconditionally, so "wired in" means wired
# into a job the narrowing cannot skip — not merely present somewhere in the file.
unconditional_job="$(awk '
  /^  workflow-security:$/ { injob = 1; next }
  /^  [A-Za-z0-9_-]+:$/    { injob = 0 }
  injob                    { print }
' "$CI")"

if grep -qF 'node scripts/validate-changesets.mjs' <<<"$unconditional_job"; then
  pass "workflow-security runs the changeset validator — no affected-cone narrowing can skip it"
else
  fail "$CI must run \`node scripts/validate-changesets.mjs\` inside workflow-security"
fi
if grep -qF 'scripts/test-validate-changesets.sh' <<<"$unconditional_job"; then
  pass "workflow-security runs this contract test"
else
  fail "$CI must run scripts/test-validate-changesets.sh inside workflow-security"
fi

if (( failures > 0 )); then
  printf '\n%d failure(s)\n' "$failures" >&2
  exit 1
fi

printf '\nchangeset validation contract ok\n'
