#!/usr/bin/env bash
# Static contract for the @reddb-io/worker vendored-source topology.

set -euo pipefail

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'PASS: %s\n' "$1"
}

if [ -e .gitmodules ]; then
  fail ".gitmodules must be absent after the worker package is vendored"
fi
pass "no .gitmodules file remains"

mode="$(git ls-files --stage packages/worker | awk '{print $1}' | sort -u | tr '\n' ' ')"
case " $mode " in
  *" 160000 "*) fail "packages/worker must be a file tree, not a gitlink" ;;
esac
pass "packages/worker is tracked as files"

if [ -e packages/worker/.git ]; then
  fail "packages/worker/.git must not be imported"
fi
pass "embedded submodule .git file is absent"

if [ -d packages/worker/.changeset ]; then
  fail "packages/worker/.changeset must not be imported"
fi
pass "standalone changesets are absent"

test -f packages/worker/.upstream || fail "packages/worker/.upstream is required"
pass "upstream marker is present"

node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('packages/worker/package.json', 'utf8'));
const need = (ok, msg) => {
  if (!ok) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`PASS: ${msg}`);
};

need(pkg.name === '@reddb-io/worker', 'package is named @reddb-io/worker');
need(pkg.main === './src/index.ts', '@reddb-io/worker main points at source');
need(pkg.types === './src/index.ts', '@reddb-io/worker types point at source');
need(pkg.exports?.['.'] === './src/index.ts', '@reddb-io/worker root export points at source');
need(pkg.scripts?.test === 'vitest run', '@reddb-io/worker test script is wired');
need(pkg.scripts?.typecheck === 'tsgo --noEmit', '@reddb-io/worker typecheck script is wired');
NODE

printf '\n@reddb-io/worker vendor contract ok\n'
