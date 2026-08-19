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

# 2 — Single version anchor: apps/plugin-dev/package.json (not cwd package.json)
if grep -qF 'PRODUCT_VERSION_ANCHOR' "$SCRIPT" && grep -qF 'apps/plugin-dev/package.json' "$SCRIPT"; then
  pass "bundle-app anchors version at apps/plugin-dev/package.json"
else
  fail "bundle-app must anchor version at apps/plugin-dev/package.json (PRODUCT_VERSION_ANCHOR)"
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

# 10 — Memory tokenizer ranks are a lazy, package-owned sibling asset (#3956)
MEMORY_PACKAGE="apps/plugin-memory/package.json"
MEMORY_BUNDLE="dist/memory.bundle.min.mjs"
MEMORY_TOKENIZER="dist/memory-tokenizer.asset.cjs"
MEMORY_BUNDLE_BEFORE=10698895
RANK_TABLE_PREFIX='bpe_ranks:"! 0 IQ== Ig== Iw=='
memory_asset_backup="$(mktemp -d)"
for asset in "$MEMORY_BUNDLE" "$MEMORY_TOKENIZER"; do
  if [[ -f "$asset" ]]; then
    cp "$asset" "$memory_asset_backup/$(basename "$asset")"
  fi
done
cleanup_memory_assets() {
  for asset in "$MEMORY_BUNDLE" "$MEMORY_TOKENIZER"; do
    rm -f -- "$asset"
    if [[ -f "$memory_asset_backup/$(basename "$asset")" ]]; then
      cp "$memory_asset_backup/$(basename "$asset")" "$asset"
    fi
  done
  rm -rf -- "$memory_asset_backup"
}
trap cleanup_memory_assets EXIT

if grep -qF -- '--lazy-asset-entry src/tokenizer-asset.ts' "$MEMORY_PACKAGE" \
  && grep -qF -- '--lazy-asset memory-tokenizer.asset.cjs' "$MEMORY_PACKAGE"; then
  pass "memory bundle declares its lazy tokenizer asset"
else
  fail "memory bundle must declare the lazy tokenizer entry and sibling asset"
fi

if pnpm -C apps/plugin-memory bundle:cli >/dev/null; then
  pass "memory CLI bundle and tokenizer asset build"
else
  fail "memory CLI bundle and tokenizer asset must build"
fi

if [[ -f "$MEMORY_BUNDLE" && -f "$MEMORY_TOKENIZER" ]]; then
  pass "memory tokenizer asset is emitted beside the bundle"
else
  fail "memory tokenizer asset must be emitted beside the bundle"
fi

if [[ -f "$MEMORY_BUNDLE" ]]; then
  memory_bundle_after="$(wc -c < "$MEMORY_BUNDLE")"
  printf 'INFO: memory bundle bytes before=%d after=%d\n' \
    "$MEMORY_BUNDLE_BEFORE" "$memory_bundle_after"
  if ! grep -qF "$RANK_TABLE_PREFIX" "$MEMORY_BUNDLE"; then
    pass "memory bundle carries no inline BPE rank table"
  else
    fail "memory bundle must not inline BPE rank tables"
  fi
fi

if [[ -f "$MEMORY_TOKENIZER" ]] && grep -qF "$RANK_TABLE_PREFIX" "$MEMORY_TOKENIZER"; then
  pass "memory tokenizer sibling asset carries the BPE ranks"
else
  fail "memory tokenizer sibling asset must carry the BPE ranks"
fi

lazy_probe="$(mktemp -d)"
cp "$MEMORY_BUNDLE" "$lazy_probe/memory.bundle.min.mjs"
if node "$lazy_probe/memory.bundle.min.mjs" --help >/dev/null; then
  pass "memory bundle starts without loading the absent tokenizer asset"
else
  fail "memory bundle must not load tokenizer ranks before a count is requested"
fi
rm -r -- "$lazy_probe"

if grep -qF 'memory-tokenizer.asset.cjs' scripts/build-pi-packages.mjs; then
  pass "scripts/build-pi-packages.mjs stages the memory tokenizer asset"
else
  fail "scripts/build-pi-packages.mjs must stage the memory tokenizer asset"
fi

if grep -qF 'memory-tokenizer.asset.cjs' packaging/npm/scripts/prepare.mjs; then
  fail "packaging/npm/scripts/prepare.mjs must not stage the plugin-owned memory tokenizer asset"
else
  pass "packaging/npm/scripts/prepare.mjs leaves the memory tokenizer asset in the memory plugin package"
fi

if (( failures > 0 )); then
  printf '\n%d failure(s)\n' "$failures" >&2
  exit 1
fi

printf '\nbundle-app contract ok\n'
