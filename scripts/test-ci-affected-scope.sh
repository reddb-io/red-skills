#!/usr/bin/env bash
# Contract for the CI affected-cone scoper (scripts/ci-affected-scope.mjs) and
# for the way red-workspace-ci.yml consumes it.
#
# Two things must hold together: the scoper must narrow correctly (and fall back
# to the whole workspace whenever it cannot classify a path), and the workflow
# must keep every required check reporting a conclusion — narrowing happens at
# step level, never by removing a job from the event.

set -euo pipefail

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'PASS: %s\n' "$1"
}

scope_of() {
  # usage: scope_of <newline-separated changed files>
  printf '%s\n' "$1" | node scripts/ci-affected-scope.mjs --files-stdin
}

assert_field() {
  # usage: assert_field <json> <node expression over `s`> <expected> <label>
  local json="$1" expr="$2" expected="$3" label="$4"
  local actual
  actual="$(JSON="$json" node --input-type=module -e "
    const s = JSON.parse(process.env.JSON);
    const value = ($expr);
    console.log(Array.isArray(value) ? value.join(',') : String(value));
  ")"
  [ "$actual" = "$expected" ] || fail "$label — expected '$expected', got '$actual'"
  pass "$label"
}

# ---------- docs-only changes ----------

docs="$(scope_of '.red/adr/0130-example.md
.red/contexts/dev/CONTEXT.md')"

assert_field "$docs" "s.mode" "cone" "docs-only change stays in cone mode"
assert_field "$docs" "s.runTypecheck" "false" "docs-only change does not typecheck"
assert_field "$docs" "s.testPackages" "apps/dev" "docs-only change tests only apps/dev (the doc-contract suite)"

researches="$(scope_of '.red/researches/notes.md')"
assert_field "$researches" "s.testPackages.length" "0" "untested doc lane runs no package tests"
assert_field "$researches" "s.runTypecheck" "false" "untested doc lane does not typecheck"

# ---------- single-package changes ----------

leaf="$(scope_of 'apps/afk-container/src/entry.ts')"
assert_field "$leaf" "s.mode" "cone" "leaf-package change stays in cone mode"
assert_field "$leaf" "s.testPackages" "apps/afk-container" "leaf-package change tests only that package"
assert_field "$leaf" "s.runTypecheck" "true" "source change typechecks"

# ---------- shared-package changes fan out to dependents ----------

shared="$(scope_of 'packages/shared/src/args.ts')"
assert_field "$shared" "s.mode" "cone" "shared-package change stays in cone mode"
assert_field "$shared" "s.testPackages.includes('packages/shared')" "true" "shared cone includes the touched package"
assert_field "$shared" "s.testPackages.includes('apps/dev')" "true" "shared cone includes apps/dev (a dependent)"
assert_field "$shared" "s.testPackages.includes('apps/opencode-host')" "true" "shared cone includes apps/opencode-host (a dependent)"
# red-browser, not afk-container: the "unrelated" example has to be a package
# with no path to packages/shared in the workspace graph, and afk-container
# stopped being one when packages/github (its dependency) took a dependency on
# shared. red-browser's workspace deps are the browser-bridge/cdp-driver pair,
# neither of which reaches shared. If this assertion trips, first check whether
# the example rotted the same way before suspecting the cone computation.
assert_field "$shared" "s.testPackages.includes('apps/red-browser')" "false" "shared cone excludes an unrelated package"

# ---------- unclassifiable / global-blast-radius changes ----------

for global_path in \
  ".github/workflows/red-workspace-ci.yml" \
  "pnpm-lock.yaml" \
  "package.json" \
  "turbo.json" \
  "scripts/ci-affected-scope.mjs" \
  "some/unknown/place.txt"; do
  out="$(scope_of "$global_path")"
  assert_field "$out" "s.mode" "whole-workspace" "'$global_path' falls back to the whole workspace"
  assert_field "$out" "s.runTypecheck" "true" "'$global_path' typechecks"
done

whole="$(scope_of 'pnpm-lock.yaml')"
assert_field "$whole" "s.testPackages.includes('apps/dev')" "true" "whole-workspace mode lists every tested package (apps/dev)"
assert_field "$whole" "s.testPackages.includes('packages/red-castle')" "true" "whole-workspace mode lists every tested package (red-castle)"

empty="$(scope_of '')"
assert_field "$empty" "s.mode" "whole-workspace" "an empty changed-file set falls back to the whole workspace"

# ---------- generated-manifest inputs ----------

plugin="$(scope_of 'plugins/dev/skills/engineering/red-setup/SKILL.md')"
assert_field "$plugin" "s.runManifestChecks" "true" "a plugin doc change re-checks the generated manifests"
assert_field "$plugin" "s.runTypecheck" "false" "a plugin doc change does not typecheck"
assert_field "$plugin" "s.testPackages" "apps/dev" "a plugin doc change tests apps/dev"

leaf_manifests="$(scope_of 'apps/afk-container/src/entry.ts')"
assert_field "$leaf_manifests" "s.runManifestChecks" "false" "an unrelated source change skips the manifest checks"

# ---------- GitHub Actions output rendering ----------

gh_out="$(mktemp)"
trap 'rm -f "$gh_out"' EXIT
printf 'apps/afk-container/src/entry.ts\n' |
  GITHUB_OUTPUT="$gh_out" node scripts/ci-affected-scope.mjs --files-stdin --github-output >/dev/null
grep -q '^mode=cone$' "$gh_out" || fail "--github-output must write mode="
grep -q '^run_typecheck=true$' "$gh_out" || fail "--github-output must write run_typecheck="
grep -q '^test_packages=\["apps/afk-container"\]$' "$gh_out" ||
  fail "--github-output must write test_packages= as a JSON array (fromJSON-consumable)"
pass "--github-output emits GitHub-Actions-consumable outputs"

# ---------- workflow wiring: required checks must always report ----------

workflow=".github/workflows/red-workspace-ci.yml"
test -f "$workflow" || fail "$workflow is required"

node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';

const text = readFileSync('.github/workflows/red-workspace-ci.yml', 'utf8');
const need = (ok, msg) => {
  if (!ok) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`PASS: ${msg}`);
};

// Trigger-level path filtering removes the check from the PR entirely, which
// leaves branch protection waiting forever for a conclusion that never arrives.
// Narrowing must happen inside the jobs, at step level.
const trigger = text.slice(0, text.indexOf('\njobs:'));
need(!/^\s*paths(-ignore)?:/m.test(trigger),
  'red-workspace-ci does not filter its triggers by path');

need(/^\s{2}scope:/m.test(text), 'red-workspace-ci defines a scope job');
need(/ci-affected-scope\.mjs/.test(text), 'the scope job runs the affected-cone scoper');

const jobBody = (job) => {
  const start = text.indexOf(`\n  ${job}:`);
  need(start !== -1, `red-workspace-ci still defines the ${job} job`);
  const rest = text.slice(start + 1);
  const end = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return end === -1 ? rest : rest.slice(0, end);
};

// The narrowing jobs do the work. Each one always runs and shrinks itself from
// the inside.
for (const job of ['typecheck', 'test-shard', 'test-packages']) {
  const body = jobBody(job);
  need(/needs:\s*(scope|\[[^\]]*scope)/.test(body), `${job} consumes the scope job`);
  need(/if:\s/.test(body), `${job} narrows its work with step-level conditions`);
  // A job-level `if:` would report as "skipped", which branch protection treats
  // as a missing conclusion for a required check.
  need(!/^ {4}if:/m.test(body), `${job} has no job-level if (it must always report)`);
}

// The apps/dev suite is the critical path, so it fans out across a shard matrix
// rather than running as one serial step.
const shard = jobBody('test-shard');
need(/^\s+matrix:\n\s+shard: \[1, 2, 3, 4\]$/m.test(shard),
  'test-shard fans the apps/dev suite out over a 4-way matrix');
need(/--shard=\$\{\{ matrix\.shard \}\}\/4/.test(shard),
  'test-shard passes its matrix index to vitest');
// pnpm forwards a `--` separator VERBATIM, so vitest reads the flag behind it
// as a filename filter and every shard runs the whole suite — four full runs
// that all pass, which is what a broken split looks like from the outside.
need(!/test\s+--\s+--shard=/.test(shard),
  'test-shard passes the shard flag with no `--` separator for pnpm to forward');
need(/fail-fast: false/.test(shard),
  'test-shard reports every failing shard, not only the first');

// `test` is the required check name. It survives the fan-out as an aggregate,
// and it is the ONE job here that carries a job-level `if:` — `always()`, so a
// failed dependency cannot skip it into a silent pass.
const aggregate = jobBody('test');
need(/needs:\s*\[[^\]]*test-shard[^\]]*\]/.test(aggregate), 'test aggregates the shard matrix');
need(/needs:\s*\[[^\]]*test-packages[^\]]*\]/.test(aggregate), 'test aggregates the per-package suites');
need(/^ {4}if: always\(\)$/m.test(aggregate), 'test always runs, so it always reports a conclusion');
need(/contains\(needs\.\*\.result, 'failure'\)/.test(aggregate)
  && /contains\(needs\.\*\.result, 'cancelled'\)/.test(aggregate),
  'test fails when any dependency failed or was cancelled');
NODE

printf '\nAll CI affected-scope contract checks passed.\n'
