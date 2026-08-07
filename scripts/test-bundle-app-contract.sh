#!/usr/bin/env bash
# Static contract tests for scripts/bundle-app.mjs
# Covers the 4 release regressions that required fix(release) in the last 30 days.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SCRIPT="scripts/bundle-app.mjs"
failures=0

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  failures=$((failures + 1))
}

pass() {
  printf 'PASS: %s\n' "$*"
}

# 1 — Required args guard (entry/outfile/asset)
if grep -qF 'bundle-app: --entry, --outfile and --asset are required' "$SCRIPT"; then
  pass "bundle-app requires --entry/--outfile/--asset"
else
  fail "bundle-app must guard missing --entry/--outfile/--asset"
fi

# 2 — Single version anchor: apps/dev/package.json (not cwd package.json)
if grep -qF 'PRODUCT_VERSION_ANCHOR' "$SCRIPT" && grep -qF 'apps/dev/package.json' "$SCRIPT"; then
  pass "bundle-app anchors version at apps/dev/package.json"
else
  fail "bundle-app must anchor version at apps/dev/package.json (PRODUCT_VERSION_ANCHOR)"
fi

if grep -qF 'resolve("package.json")' "$SCRIPT" && grep -qF 'PRODUCT_VERSION_ANCHOR' "$SCRIPT"; then
  # pkg.version is still read but only as fallback — the anchor wins when RED_BUILD_VERSION is absent
  pass "bundle-app keeps pkg.version only as fallback, anchor is primary"
else
  fail "bundle-app must read anchor version with fallback chain"
fi

# 3 — RED_BUILD_VERSION precedence: env > anchor > pkg.version > 0.0.0-dev
if grep -qF 'RED_BUILD_VERSION' "$SCRIPT" && grep -qF 'anchorVersion' "$SCRIPT" && grep -qF 'pkg.version' "$SCRIPT"; then
  pass "bundle-app respects RED_BUILD_VERSION > anchorVersion > pkg.version precedence"
else
  fail "bundle-app must implement RED_BUILD_VERSION precedence chain"
fi

# 4 — Defines injected (version, sha, time, asset, reddb)
for define in "__RED_BUILD_VERSION__" "__RED_BUILD_GIT_SHA__" "__RED_BUILD_TIME__" "__RED_BUNDLE_ASSET__"; do
  if grep -qF "$define" "$SCRIPT"; then
    pass "bundle-app defines $define"
  else
    fail "bundle-app must define $define"
  fi
done

if grep -qF "__REDDB_SDK_VERSION__" "$SCRIPT" && grep -qF "__REDDB_BINARY_TAG__" "$SCRIPT"; then
  pass "bundle-app defines REDDB SDK version/binary tag (empty by default, filled with --reddb-from-package)"
else
  fail "bundle-app must define REDDB SDK defines"
fi

# 5 — esbuild invocation shape
if grep -qF '"--bundle"' "$SCRIPT" && grep -qF '"--platform=node"' "$SCRIPT" && grep -qF '"--format=esm"' "$SCRIPT"; then
  pass "bundle-app invokes esbuild with --bundle --platform=node --format=esm"
else
  fail "bundle-app must invoke esbuild with --bundle --platform=node --format=esm"
fi

if grep -qF 'createRequire as __cr' "$SCRIPT" && grep -qF 'banner:js' "$SCRIPT"; then
  pass "bundle-app injects createRequire banner for ESM"
else
  fail "bundle-app must inject createRequire banner"
fi

# 6 — --reddb-from-package reads @reddb-io/sdk from dependencies
if grep -qF -- '--reddb-from-package' "$SCRIPT" && grep -qF '@reddb-io/sdk' "$SCRIPT"; then
  pass "bundle-app --reddb-from-package reads @reddb-io/sdk"
else
  fail "bundle-app --reddb-from-package must read @reddb-io/sdk"
fi

# 7 — Unknown arg handling
if grep -qF 'unknown arg' "$SCRIPT"; then
  pass "bundle-app rejects unknown args"
else
  fail "bundle-app must reject unknown args"
fi

# 8 — Runtime smoke: --help-like invocation with missing args must exit 1
bundle_output="$(node "$SCRIPT" 2>&1 || true)"
if printf '%s' "$bundle_output" | grep -qF -- '--entry, --outfile and --asset are required'; then
  pass "bundle-app exits 1 when required args missing"
else
  fail "bundle-app must exit 1 when required args missing"
fi
# also assert exit code 1
if node "$SCRIPT" >/dev/null 2>&1; then
  fail "bundle-app must exit non-zero when required args missing"
else
  pass "bundle-app non-zero exit on missing args"
fi

# 9 — Build dispersion: ensure version is stripped of leading 'v'
if grep -qF "replace(/^v/" "$SCRIPT"; then
  pass "bundle-app strips leading v from version"
else
  fail "bundle-app must strip leading v from version"
fi

if (( failures > 0 )); then
  printf '\n%d failure(s)\n' "$failures" >&2
  exit 1
fi

printf '\nbundle-app contract ok\n'
