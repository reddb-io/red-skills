#!/usr/bin/env bash
# Static contract tests for the 3 manifest generators + pi package builder
# Catches drift where a skill is added but manifests are not regenerated (see #3403, #3419, #3436, #3445)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

failures=0
fail() { printf 'FAIL: %s\n' "$*" >&2; failures=$((failures + 1)); }
pass() { printf 'PASS: %s\n' "$*"; }

# 1 — Generators exist and are executable
for gen in scripts/generate-codex-manifests.mjs scripts/generate-gemini-manifests.mjs scripts/generate-pi-manifests.mjs scripts/build-pi-packages.mjs; do
  if [[ -f "$gen" ]]; then
    pass "$gen exists"
  else
    fail "$gen missing"
  fi
done

# 2 — Manifest core lib exists (shared by codex/pi, gemini duplicates parseArgs — see codex:14 vs gemini:14)
if [[ -f "scripts/lib/manifest-core.mjs" ]] && grep -qF 'lib/manifest-core' scripts/generate-codex-manifests.mjs; then
  pass "manifest core exists and codex reuses it (gemini currently duplicates parseArgs)"
else
  fail "scripts/lib/manifest-core.mjs must exist and be reused by at least one generator"
fi

# 3 — Each generator supports --check (drift detection) via lib/manifest-core parseArgs
if grep -qF -- '--check' scripts/lib/manifest-core.mjs; then
  pass "manifest-core supports --check (all generators inherit it)"
else
  fail "lib/manifest-core.mjs must support --check"
fi
for gen in scripts/generate-codex-manifests.mjs scripts/generate-gemini-manifests.mjs scripts/generate-pi-manifests.mjs scripts/build-pi-packages.mjs; do
  if grep -qF 'parseArgs' "$gen" || grep -qF 'check' "$gen"; then
    pass "$gen wires check through parseArgs"
  else
    fail "$gen must wire check through parseArgs"
  fi
done

# 4 — Codex generator projects Claude marketplace into Codex specific outputs
if grep -qF '.codex-plugin/plugin.json' scripts/generate-codex-manifests.mjs; then
  pass "codex generator writes .codex-plugin/plugin.json"
else
  fail "codex generator must write .codex-plugin/plugin.json"
fi

if grep -qF '.agents/plugins/marketplace.json' scripts/generate-codex-manifests.mjs; then
  pass "codex generator writes .agents/plugins/marketplace.json"
else
  fail "codex generator must write .agents/plugins/marketplace.json"
fi

# 5 — Pi packages generator produces per-skill npm packages under packaging/pi
if grep -qF 'packaging/pi' scripts/build-pi-packages.mjs; then
  pass "pi packages builder targets packaging/pi"
else
  fail "pi packages builder must target packaging/pi"
fi

# 6 — Idempotence: running generators twice produces no diff (no --check failure when already fresh)
set +e
pnpm codex:manifests:check >/tmp/codex-check.log 2>&1; codex_rc=$?
pnpm gemini:manifests:check >/tmp/gemini-check.log 2>&1; gemini_rc=$?
pnpm pi:manifests:check >/tmp/pi-check.log 2>&1; pi_rc=$?
pnpm pi:packages:check >/tmp/pi-pkg-check.log 2>&1; pi_pkg_rc=$?
set -e

if [[ $codex_rc -eq 0 ]]; then
  pass "codex manifests are fresh (idempotent)"
else
  fail "codex manifests drift — run pnpm generate-manifests"
  cat /tmp/codex-check.log >&2 || true
fi
if [[ $gemini_rc -eq 0 ]]; then
  pass "gemini manifests are fresh"
else
  fail "gemini manifests drift"
  cat /tmp/gemini-check.log >&2 || true
fi
if [[ $pi_rc -eq 0 ]]; then
  pass "pi manifests are fresh"
else
  fail "pi manifests drift"
  cat /tmp/pi-check.log >&2 || true
fi
if [[ $pi_pkg_rc -eq 0 ]]; then
  pass "pi packages are fresh"
else
  fail "pi packages drift — run pnpm pi:packages:build"
  cat /tmp/pi-pkg-check.log >&2 || true
fi

# 7 — Validation scope: .red/config.yaml declares generated paths for CI narrowing (ADR 0135)
if grep -qF 'plugins/*/skills/**' .red/config.yaml && grep -qF 'plugins/*/.codex-plugin/plugin.json' .red/config.yaml; then
  pass ".red/config.yaml validation.generated.paths covers skills + manifests"
else
  fail ".red/config.yaml must declare validation.generated.paths for skills and manifests"
fi

# 8 — package.json scripts expose check variants for CI
for script in "codex:manifests:check" "gemini:manifests:check" "pi:manifests:check" "pi:packages:check"; do
  if grep -qF "$script" package.json; then
    pass "package.json exposes $script"
  else
    fail "package.json must expose $script"
  fi
done

if (( failures > 0 )); then
  printf '\n%d failure(s)\n' "$failures" >&2
  exit 1
fi

printf '\nmanifest generation contract ok\n'
