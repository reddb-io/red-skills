#!/usr/bin/env bash
# Static contract for the red-castle vendored-source topology.

set -euo pipefail

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'PASS: %s\n' "$1"
}

if [ -e .gitmodules ]; then
  fail ".gitmodules must be absent after red-castle is vendored"
fi
pass "no .gitmodules file remains"

mode="$(git ls-files --stage packages/red-castle | awk '{print $1}' | sort -u | tr '\n' ' ')"
case " $mode " in
  *" 160000 "*) fail "packages/red-castle must be a file tree, not a gitlink" ;;
esac
pass "packages/red-castle is tracked as files"

if [ -e packages/red-castle/.git ]; then
  fail "packages/red-castle/.git must not be imported"
fi
pass "embedded submodule .git file is absent"

if [ -d packages/red-castle/.changeset ]; then
  fail "packages/red-castle/.changeset must not be imported"
fi
pass "standalone changesets are absent"

test -f packages/red-castle/.upstream || fail "packages/red-castle/.upstream is required"
pass "upstream marker is present"

node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('packages/red-castle/package.json', 'utf8'));
const need = (ok, msg) => {
  if (!ok) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`PASS: ${msg}`);
};

need(pkg.main === './src/index.ts', 'red-castle main points at source');
need(pkg.types === './src/index.ts', 'red-castle types point at source');
need(pkg.exports?.['.'] === './src/index.ts', 'red-castle root export points at source');
need(pkg.scripts?.test === 'vitest run', 'red-castle test script is wired');
need(pkg.scripts?.typecheck === 'tsgo --noEmit', 'red-castle typecheck script is wired');
NODE

printf '\nred-castle vendor contract ok\n'
