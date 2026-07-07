#!/usr/bin/env bash
# Contract tests for the red-release bump-kind decision script.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

failures=0

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  failures=$((failures + 1))
}

pass() {
  printf 'PASS: %s\n' "$*"
}

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

commits="$tmpdir/commits.json"
workflow=".github/workflows/red-release.yml"
cat > "$commits" <<'JSON'
[
  {
    "hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "subject": "feat!: replace bundle transport",
    "body": ""
  },
  {
    "hash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "subject": "fix: preserve release smoke",
    "body": "BREAKING CHANGE: changes the bootstrap contract"
  }
]
JSON

run_decider() {
  local allow_major="$1" stdout_file="$2" output_file="$3"
  RED_RELEASE_COMMIT_FIXTURE="$commits" \
    RED_RELEASE_ALLOW_MAJOR="$allow_major" \
    GITHUB_OUTPUT="$output_file" \
    node scripts/decide-release-bump-kind.mjs > "$stdout_file"
}

stdout="$tmpdir/no-opt-in.stdout"
outputs="$tmpdir/no-opt-in.outputs"
if run_decider "" "$stdout" "$outputs"; then
  if grep -q '^kind=minor$' "$outputs"; then
    pass "breaking markers degrade to minor without maintainer opt-in"
  else
    fail "breaking markers without opt-in must output kind=minor"
  fi

  if grep -q '^consume_major_opt_in=false$' "$outputs"; then
    pass "missing opt-in does not request consumption"
  else
    fail "missing opt-in must output consume_major_opt_in=false"
  fi

  if grep -q '^::warning::' "$stdout" &&
     grep -q 'aaaaaaaa feat!: replace bundle transport' "$stdout" &&
     grep -q 'bbbbbbbb fix: preserve release smoke' "$stdout"; then
    pass "warning names commits that requested a major bump"
  else
    fail "warning must name every breaking-marker commit"
  fi
else
  fail "decider failed without opt-in"
fi

stdout="$tmpdir/opt-in.stdout"
outputs="$tmpdir/opt-in.outputs"
if run_decider "true" "$stdout" "$outputs"; then
  if grep -q '^kind=major$' "$outputs"; then
    pass "maintainer opt-in allows major bump"
  else
    fail "maintainer opt-in must output kind=major"
  fi

  if grep -q '^consume_major_opt_in=true$' "$outputs"; then
    pass "major opt-in is marked for single-shot consumption"
  else
    fail "major opt-in must be marked for consumption"
  fi
else
  fail "decider failed with opt-in"
fi

if grep -qF 'run: scripts/test-red-release-bump-kind.sh' "$workflow"; then
  pass "release workflow runs the bump-kind contract test"
else
  fail "release workflow must run scripts/test-red-release-bump-kind.sh"
fi

if grep -qF 'node scripts/decide-release-bump-kind.mjs' "$workflow" &&
   grep -qF 'RED_RELEASE_ALLOW_MAJOR: ${{ vars.RED_RELEASE_ALLOW_MAJOR }}' "$workflow"; then
  pass "release workflow delegates bump decisions to the guarded script"
else
  fail "release workflow must call the guarded bump-kind script with the maintainer variable"
fi

if grep -qF 'steps.bump.outputs.consume_major_opt_in == '\''true'\''' "$workflow" &&
   grep -qF 'gh variable delete RED_RELEASE_ALLOW_MAJOR' "$workflow"; then
  pass "release workflow consumes the major opt-in variable"
else
  fail "release workflow must consume RED_RELEASE_ALLOW_MAJOR after a major decision"
fi

if (( failures > 0 )); then
  printf '\n%d failure(s)\n' "$failures" >&2
  exit 1
fi

printf '\nred-release bump kind contract ok\n'
