#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

pass() {
  printf 'PASS: %s\n' "$*"
}

WORKFLOW=".github/workflows/red-publish.yml"
WORKSPACE_CI=".github/workflows/red-workspace-ci.yml"

line_of_step() {
  local step="$1"
  grep -nF -- "- name: $step" "$WORKFLOW" | head -n1 | cut -d: -f1
}

contract_line="$(line_of_step "Test package-set contract" || true)"
build_line="$(line_of_step "Build, sign, and offline-verify package set" || true)"
release_line="$(line_of_step "GitHub Release" || true)"
[ -n "$contract_line" ] || fail "release workflow must run the focused package-set contract"
[ -n "$build_line" ] || fail "release workflow must build and verify the package set"
[ -n "$release_line" ] || fail "release workflow must publish GitHub assets"
[ "$contract_line" -lt "$build_line" ] && [ "$build_line" -lt "$release_line" ] ||
  fail "package-set contract, build, and release upload must run in order"

grep -qF 'uses: sigstore/cosign-installer@398d4b0eeef1380460a10c8013a76f728fb906ac' "$WORKFLOW" ||
  fail "release workflow must install cosign from the pinned v3 commit"
grep -qF 'node scripts/build-package-set.mjs' "$WORKFLOW" ||
  fail "release workflow must use the deterministic package-set producer"
grep -qF 'SOURCE_COMMIT: ${{ steps.target.outputs.sha }}' "$WORKFLOW" ||
  fail "package-set identity must use the resolved release tag commit"
grep -qF 'cosign sign-blob' "$WORKFLOW" && grep -qF 'dist/package-set.manifest.sigstore.json' "$WORKFLOW" ||
  fail "release workflow must sign the package-set manifest into a Sigstore bundle"
grep -qF 'unshare --net' "$WORKFLOW" && grep -qF 'scripts/verify-package-set.mjs' "$WORKFLOW" ||
  fail "release workflow must smoke the verifier with network access blocked"
# The legacy bundle shape reads trust roots from an older TUF store nothing in
# cosign 2.5 primes, so its offline verify always reached for the network and
# failed (v3.19.0). The Sigstore bundle format plus an explicit trusted root,
# fetched by `cosign initialize` BEFORE the network drop, is the recipe.
grep -qF -- '--new-bundle-format' "$WORKFLOW" ||
  fail "release workflow must sign in the Sigstore bundle format"
initialize_line="$(grep -nF 'cosign initialize' "$WORKFLOW" | head -n1 | cut -d: -f1)"
unshare_line="$(grep -nF 'unshare --net' "$WORKFLOW" | head -n1 | cut -d: -f1)"
[ -n "$initialize_line" ] && [ "$initialize_line" -lt "$unshare_line" ] ||
  fail "release workflow must run 'cosign initialize' before dropping the network"
grep -qF -- '--trusted-root "$trusted_root"' "$WORKFLOW" ||
  fail "release offline verify must hand the verifier the cached trusted root"
SMOKE=".github/workflows/red-package-set-smoke.yml"
grep -qF 'cosign sign-blob' "$SMOKE" && grep -qF -- '--new-bundle-format' "$SMOKE" &&
  grep -qF 'cosign initialize' "$SMOKE" && grep -qF -- '--trusted-root' "$SMOKE" &&
  grep -qF 'unshare --net' "$SMOKE" && grep -qF 'scripts/verify-package-set.mjs' "$SMOKE" ||
  fail "pull-request smoke must rehearse the release's real cosign sign + offline verify recipe"
for asset in \
  dist/package-set.manifest.json \
  dist/package-set.manifest.sigstore.json \
  dist/verify-package-set.mjs; do
  grep -qF "$asset" "$WORKFLOW" || fail "release upload must carry $asset"
done
pass "release workflow builds, signs, verifies, and uploads the package set"
grep -qF 'run: scripts/test-package-set-contract.sh' "$WORKSPACE_CI" ||
  fail "workspace CI must run the package-set contract before merge"
pass "workspace CI runs the package-set contract before merge"

source_commit="1111111111111111111111111111111111111111"
other_commit="2222222222222222222222222222222222222222"
mkdir -p "$tmp/assets" "$tmp/bin"
printf 'alpha payload\n' >"$tmp/assets/alpha.bin"
printf 'beta payload\n' >"$tmp/assets/beta.bin"

# The fake is a deterministic stand-in for cosign's offline verify-blob
# boundary. It deliberately refuses any invocation without --offline, checks
# the pinned workflow identity/issuer, and authenticates the exact manifest
# bytes against the fixture bundle. The release smoke exercises real cosign.
cat >"$tmp/bin/cosign" <<'EOF'
#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] !== "verify-blob" || !args.includes("--offline")) process.exit(20);
const value = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
if (value("--certificate-oidc-issuer") !== "https://token.actions.githubusercontent.com") process.exit(21);
const identity = value("--certificate-identity-regexp") ?? "";
if (!identity.includes("red-publish\\.yml") || !identity.includes("refs/tags/v")) process.exit(22);
const bundle = JSON.parse(readFileSync(value("--bundle"), "utf8"));
const manifest = readFileSync(args.at(-1));
const digest = createHash("sha256").update(manifest).digest("hex");
process.exit(bundle.sha256 === digest ? 0 : 23);
EOF
chmod +x "$tmp/bin/cosign"

sign_fixture() {
  local manifest="$1" bundle="$2"
  node --input-type=module - "$manifest" "$bundle" <<'EOF'
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
const [, , manifest, bundle] = process.argv;
const sha256 = createHash("sha256").update(readFileSync(manifest)).digest("hex");
writeFileSync(bundle, `${JSON.stringify({ sha256 })}\n`);
EOF
}

build() {
  local commit="$1" out="$2"
  shift 2
  node scripts/build-package-set.mjs \
    --source-commit "$commit" \
    --out "$out" \
    "$@"
}

verify() {
  local manifest="$1" bundle="$2"
  node scripts/verify-package-set.mjs \
    --manifest "$manifest" \
    --bundle "$bundle" \
    --cosign-bin "$tmp/bin/cosign"
}

build "$source_commit" "$tmp/first.json" \
  --asset "$tmp/assets/beta.bin" \
  --asset "$tmp/assets/alpha.bin"
build "$source_commit" "$tmp/second.json" \
  --asset "$tmp/assets/alpha.bin" \
  --asset "$tmp/assets/beta.bin"
cmp -s "$tmp/first.json" "$tmp/second.json" || fail "identical inputs must produce identical manifest bytes"
pass "identical inputs produce identical manifest bytes"

first_digest="$(node -p "require('$tmp/first.json').wholeSetDigest")"
printf 'alpha payload changed\n' >"$tmp/assets/alpha.bin"
build "$source_commit" "$tmp/payload-changed.json" \
  --asset "$tmp/assets/alpha.bin" \
  --asset "$tmp/assets/beta.bin"
payload_digest="$(node -p "require('$tmp/payload-changed.json').wholeSetDigest")"
[ "$first_digest" != "$payload_digest" ] || fail "payload changes must change the whole-set digest"
pass "payload changes alter the whole-set digest"

printf 'alpha payload\n' >"$tmp/assets/alpha.bin"
build "$other_commit" "$tmp/commit-changed.json" \
  --asset "$tmp/assets/alpha.bin" \
  --asset "$tmp/assets/beta.bin"
commit_digest="$(node -p "require('$tmp/commit-changed.json').wholeSetDigest")"
[ "$first_digest" != "$commit_digest" ] || fail "source commit changes must change the whole-set digest"
pass "source commit changes alter the whole-set digest"

cp "$tmp/first.json" "$tmp/assets/package-set.manifest.json"
sign_fixture "$tmp/assets/package-set.manifest.json" "$tmp/assets/package-set.manifest.sigstore.json"
verify "$tmp/assets/package-set.manifest.json" "$tmp/assets/package-set.manifest.sigstore.json" >/dev/null
pass "valid local package set verifies"

printf '{"sha256":"%064d"}\n' 0 >"$tmp/assets/invalid.sigstore.json"
if verify "$tmp/assets/package-set.manifest.json" "$tmp/assets/invalid.sigstore.json" >/dev/null 2>&1; then
  fail "invalid signature must be refused"
fi
pass "invalid signature is refused"

printf 'alpha payload corrupted\n' >"$tmp/assets/alpha.bin"
if verify "$tmp/assets/package-set.manifest.json" "$tmp/assets/package-set.manifest.sigstore.json" >/dev/null 2>&1; then
  fail "checksum mismatch must be refused"
fi
pass "checksum mismatch is refused"
printf 'alpha payload\n' >"$tmp/assets/alpha.bin"

mv "$tmp/assets/beta.bin" "$tmp/assets/beta.missing"
if verify "$tmp/assets/package-set.manifest.json" "$tmp/assets/package-set.manifest.sigstore.json" >/dev/null 2>&1; then
  fail "missing asset must be refused"
fi
pass "missing asset is refused"
mv "$tmp/assets/beta.missing" "$tmp/assets/beta.bin"

node --input-type=module - "$tmp/assets/package-set.manifest.json" "$other_commit" <<'EOF'
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
const [, , path, otherCommit] = process.argv;
const manifest = JSON.parse(readFileSync(path, "utf8"));
manifest.artifacts[0].sourceCommit = otherCommit;
const identity = {
  schema: manifest.schema,
  sourceCommit: manifest.sourceCommit,
  artifacts: manifest.artifacts,
};
manifest.wholeSetDigest = createHash("sha256").update(`${JSON.stringify(identity)}\n`).digest("hex");
writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
EOF
sign_fixture "$tmp/assets/package-set.manifest.json" "$tmp/assets/cross-commit.sigstore.json"
if verify "$tmp/assets/package-set.manifest.json" "$tmp/assets/cross-commit.sigstore.json" >/dev/null 2>&1; then
  fail "cross-commit artifact must be refused"
fi
pass "cross-commit artifact is refused"

# A path escape must never let a signed manifest read outside its local asset
# directory. Re-signing proves the refusal is the package-set boundary, not an
# incidental signature failure.
cp "$tmp/first.json" "$tmp/assets/package-set.manifest.json"
node --input-type=module - "$tmp/assets/package-set.manifest.json" <<'EOF'
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
const path = process.argv[2];
const manifest = JSON.parse(readFileSync(path, "utf8"));
manifest.artifacts[0].name = "../alpha.bin";
const identity = {
  schema: manifest.schema,
  sourceCommit: manifest.sourceCommit,
  artifacts: manifest.artifacts,
};
manifest.wholeSetDigest = createHash("sha256").update(`${JSON.stringify(identity)}\n`).digest("hex");
writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
EOF
sign_fixture "$tmp/assets/package-set.manifest.json" "$tmp/assets/path-escape.sigstore.json"
if verify "$tmp/assets/package-set.manifest.json" "$tmp/assets/path-escape.sigstore.json" >/dev/null 2>&1; then
  fail "asset path escape must be refused"
fi
pass "asset path escape is refused"

if grep -Eq 'fetch\(|https?\.request|node:(http|https|net|tls|dns)' scripts/verify-package-set.mjs; then
  fail "offline verifier must not contain a network client"
fi
pass "verifier has no network client and requires cosign offline mode"
