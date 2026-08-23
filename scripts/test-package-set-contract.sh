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
# Verifying the bytes is not expanding the set. The network-denied smoke must
# run the EXPANDER — from dist/, the copy an operator downloads — so a payload
# that is signed but unusable (a tarball packed from the wrong directory, a
# Gemini extension that fails generated-path validation, a Hermes source tree
# with no plugins/dev) fails the release rather than the workstation.
grep -qF '"$(command -v node)" dist/expand-package-set.mjs' "$WORKFLOW" ||
  fail "release offline smoke must expand the set through the released expander"
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
# Neither the signed set nor the upload may hand-keep its own list of dist
# paths: two arrays in one file is how a payload lands in one and is forgotten
# in the other. Both derive from scripts/workstation-package-set.mjs.
grep -qF 'mapfile -t workstation_assets < <(node scripts/workstation-package-set.mjs --version "$VERSION")' "$WORKFLOW" ||
  fail "the signed package set must derive its members from the workstation enumeration"
grep -qF 'mapfile -t assets < <(node scripts/workstation-package-set.mjs --github-release --version "${NEXT#v}")' "$WORKFLOW" ||
  fail "the release upload must derive its assets from the workstation enumeration"
pass "release workflow builds, signs, expands, and uploads the derived package set"
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

# The fixture identity every case that is not ABOUT version/channel/targets
# builds with, so those cases stay about what they were about (#4005).
fixture_version="9.9.9"
fixture_channel="stable"
fixture_target="linux-x64"

build() {
  local commit="$1" out="$2"
  shift 2
  node scripts/build-package-set.mjs \
    --source-commit "$commit" \
    --release-version "$fixture_version" \
    --channel "$fixture_channel" \
    --target "$fixture_target" \
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
  version: manifest.version,
  channel: manifest.channel,
  targets: manifest.targets,
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
  version: manifest.version,
  channel: manifest.channel,
  targets: manifest.targets,
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

if grep -Eq 'fetch\(|https?\.request|node:(http|https|net|tls|dns)' scripts/expand-package-set.mjs; then
  fail "offline expander must not contain a network client"
fi
pass "expander has no network client"

# --- both schemas ride together while the readers migrate (#4005) ------------
#
# v2 took the canonical manifest name in 4.0.0 and red-dev — whose verifier
# mirrors v1 key-for-key — refused every set from that release with "manifest
# shape or key order is not canonical". A machine that cannot install the
# release cannot be told about the release. So the canonical name keeps the v1
# shape until the readers have flipped, and v2 rides beside it.

build_both() {
  node scripts/build-package-set.mjs \
    --source-commit "$source_commit" \
    --release-version "$fixture_version" \
    --channel "$fixture_channel" \
    --target "$fixture_target" \
    --out "$tmp/both.v2.json" \
    --legacy-out "$tmp/both.v1.json" \
    --asset "$tmp/assets/alpha.bin" \
    --asset "$tmp/assets/beta.bin" >/dev/null
}

build_both
node -e "
  const v1 = require('$tmp/both.v1.json');
  const v2 = require('$tmp/both.v2.json');
  if (v1.schema !== 'red.package-set.v1') process.exit(11);
  if (v2.schema !== 'red.package-set.v2') process.exit(12);
  if (JSON.stringify(Object.keys(v1)) !== JSON.stringify(['schema','sourceCommit','artifacts','wholeSetDigest'])) process.exit(13);
  if (JSON.stringify(v1.artifacts) !== JSON.stringify(v2.artifacts)) process.exit(14);
  if (v1.wholeSetDigest === v2.wholeSetDigest) process.exit(15);
" || fail "the two manifests must describe the same artifacts under their own identities"
pass "one build emits both schemas over the same artifacts"

cp "$tmp/both.v1.json" "$tmp/assets/package-set.manifest.json"
sign_fixture "$tmp/assets/package-set.manifest.json" "$tmp/assets/legacy.sigstore.json"
verify "$tmp/assets/package-set.manifest.json" "$tmp/assets/legacy.sigstore.json" >/dev/null ||
  fail "the shipped verifier must still verify a v1 manifest"
pass "the shipped verifier verifies the v1 manifest a migrating reader still reads"

if node scripts/verify-package-set.mjs \
  --manifest "$tmp/assets/package-set.manifest.json" \
  --bundle "$tmp/assets/legacy.sigstore.json" \
  --cosign-bin "$tmp/bin/cosign" \
  --require-target linux-x64 >/dev/null 2>&1; then
  fail "--require-target must refuse a v1 manifest, which states no targets"
fi
pass "a target requirement refuses a v1 manifest rather than reading one that is absent"

# --- the signed identity carries version, channel and targets (#4005) --------
#
# red-dev verifies the published set before it moves `~/.red/skills/current`,
# and the three facts it must decide on — which version, which channel, which
# platform the set was built for — used to sit OUTSIDE the bytes anybody signed.
# A fact a consumer decides on belongs inside the signature.

for field in version channel targets; do
  case "$field" in
    version) other=(--release-version 9.9.10 --channel "$fixture_channel" --target "$fixture_target") ;;
    channel) other=(--release-version "$fixture_version" --channel next --target "$fixture_target") ;;
    targets) other=(--release-version "$fixture_version" --channel "$fixture_channel" --target windows-x64) ;;
  esac
  node scripts/build-package-set.mjs \
    --source-commit "$source_commit" \
    "${other[@]}" \
    --out "$tmp/identity-$field.json" \
    --asset "$tmp/assets/alpha.bin" \
    --asset "$tmp/assets/beta.bin" >/dev/null
  changed="$(node -p "require('$tmp/identity-$field.json').wholeSetDigest")"
  [ "$first_digest" != "$changed" ] || fail "$field must be inside the whole-set digest"
done
pass "version, channel and targets are inside the whole-set digest"

# Tampering with a signed manifest's identity is the failure the digest exists
# for: re-signing proves the refusal is the schema boundary, not the signature.
for field in version channel targets; do
  cp "$tmp/first.json" "$tmp/assets/package-set.manifest.json"
  node --input-type=module - "$tmp/assets/package-set.manifest.json" "$field" <<'EOF'
import { readFileSync, writeFileSync } from "node:fs";
const [, , path, field] = process.argv;
const manifest = JSON.parse(readFileSync(path, "utf8"));
if (field === "version") manifest.version = "9.9.10";
if (field === "channel") manifest.channel = "next";
if (field === "targets") manifest.targets = ["windows-x64"];
writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
EOF
  sign_fixture "$tmp/assets/package-set.manifest.json" "$tmp/assets/identity-tamper.sigstore.json"
  if verify "$tmp/assets/package-set.manifest.json" "$tmp/assets/identity-tamper.sigstore.json" >/dev/null 2>&1; then
    fail "an altered $field must be refused"
  fi
done
pass "an altered version, channel or target is refused"

# The builder refuses a value no reader could decide on, at the moment it is
# cheapest to fix: before anything is signed.
for bad in "--channel nightly" "--target darwin-arm64" "--release-version v9.9.9"; do
  # shellcheck disable=SC2086
  if node scripts/build-package-set.mjs \
    --source-commit "$source_commit" \
    --release-version "$fixture_version" \
    --channel "$fixture_channel" \
    --target "$fixture_target" \
    $bad \
    --out "$tmp/refused.json" \
    --asset "$tmp/assets/alpha.bin" >/dev/null 2>&1; then
    fail "the builder must refuse $bad"
  fi
done
pass "the builder refuses an unknown channel, target, or malformed version"

# A depot is target-specific (red-dev ADR 0010): it must be able to refuse a set
# built for another platform, which is only possible once `targets` is signed.
cp "$tmp/first.json" "$tmp/assets/package-set.manifest.json"
sign_fixture "$tmp/assets/package-set.manifest.json" "$tmp/assets/target.sigstore.json"
node scripts/verify-package-set.mjs \
  --manifest "$tmp/assets/package-set.manifest.json" \
  --bundle "$tmp/assets/target.sigstore.json" \
  --cosign-bin "$tmp/bin/cosign" \
  --require-target linux-x64 >/dev/null || fail "--require-target must accept a declared target"
if node scripts/verify-package-set.mjs \
  --manifest "$tmp/assets/package-set.manifest.json" \
  --bundle "$tmp/assets/target.sigstore.json" \
  --cosign-bin "$tmp/bin/cosign" \
  --require-target windows-x64 >/dev/null 2>&1; then
  fail "--require-target must refuse a set built for another target"
fi
pass "a depot can require the target the set declares"

# A v1 reader must fail CLOSED on v2 rather than read the fields it recognises
# and ignore the three it does not. The two checks below are v1's whole
# discrimination — canonical key set, then schema string.
v1_reads_v2="$(node --input-type=module - "$tmp/first.json" <<'EOF'
import { readFileSync } from "node:fs";
const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
const V1_KEYS = ["schema", "sourceCommit", "artifacts", "wholeSetDigest"];
const sameKeys = JSON.stringify(Object.keys(manifest)) === JSON.stringify(V1_KEYS);
process.stdout.write(sameKeys && manifest.schema === "red.package-set.v1" ? "accepted" : "refused");
EOF
)"
[ "$v1_reads_v2" = "refused" ] || fail "a v1 reader must fail closed on a v2 manifest"
pass "a v1 reader fails closed on a v2 manifest"

# The schema a consumer mirrors must be written down beside the verifier it
# mirrors, or the next reader guesses.
[ -f scripts/PACKAGE-SET-SCHEMA.md ] || fail "the package-set schema must be documented beside the verifier"
for documented in red.package-set.v2 version channel targets wholeSetDigest; do
  grep -Fq "$documented" scripts/PACKAGE-SET-SCHEMA.md || fail "schema doc does not describe $documented"
done
pass "the schema is documented beside the verifier"

# --- the complete workstation package set (Ticket #3977) ---------------------
#
# This literal list is the CONTRACT. It is written out here rather than imported
# from scripts/workstation-package-set.mjs on purpose: an enumeration that
# validates itself validates nothing, and a payload added to or dropped from the
# release must be restated by whoever changed it. `--version 9.9.9` resolves the
# one version-stamped asset without pinning this test to a release.
expected_workstation=(
  dist/plugin-dev.payload.tgz
  dist/plugin-memory.payload.tgz
  dist/plugin-brain.payload.tgz
  dist/plugin-internal.payload.tgz
  dist/marketplace-manifests.tgz
  dist/opencode-host.bundle.min.mjs
  dist/opencode-host.generated.tgz
  dist/gemini-extension.tgz
  dist/build-gemini-extension.mjs
  dist/validate-gemini-extension.mjs
  dist/install-hermes-skills.mjs
  dist/redskilled-mcp.bundle.min.mjs
  dist/code-nav.bundle.min.mjs
  dist/code-nav.manifest.json
  dist/memory.bundle.min.mjs
  dist/memory-mcp.bundle.min.mjs
  dist/memory-runtime-manifest.json
  dist/brain.bundle.min.mjs
  dist/brain-mcp.bundle.min.mjs
  dist/brain-runtime-manifest.json
  dist/rsp.bundle.min.mjs
  dist/rsp-core.bundle.min.mjs
  dist/redskilled.bundle.min.mjs
  dist/statusline.bundle.min.mjs
  dist/herdr-plugin-red-skills.bundle.min.mjs
  dist/vscode-extension-red-skills-9.9.9.vsix
  dist/zellij-dashboard.tgz
  dist/verify-package-set.mjs
  dist/expand-package-set.mjs
  dist/workstation-package-set.mjs
)
mapfile -t declared_workstation < <(node scripts/workstation-package-set.mjs --version 9.9.9)
if ! diff -u \
  <(printf '%s\n' "${expected_workstation[@]}" | sort) \
  <(printf '%s\n' "${declared_workstation[@]}" | sort) >"$tmp/workstation.diff"; then
  cat "$tmp/workstation.diff" >&2
  fail "the workstation package set drifted from the declared contract"
fi
pass "the workstation package set matches the declared contract"

# The plugin payloads follow the plugin TREE, not a memory of it: a fifth plugin
# must get a payload by existing. The enumeration is static so the expander can
# read it on a machine with no checkout, so CI is where the two are tied.
mapfile -t declared_plugin_payloads < <(node scripts/workstation-package-set.mjs --plugin-payloads)
mapfile -t tree_plugin_payloads < <(
  find plugins -mindepth 3 -maxdepth 3 -path '*/.claude-plugin/plugin.json' |
    sed -E 's#^plugins/([^/]+)/.*#dist/plugin-\1.payload.tgz#'
)
if ! diff -u \
  <(printf '%s\n' "${declared_plugin_payloads[@]}" | sort) \
  <(printf '%s\n' "${tree_plugin_payloads[@]}" | sort) >"$tmp/plugins.diff"; then
  cat "$tmp/plugins.diff" >&2
  fail "the declared plugin payloads drifted from the plugin tree"
fi
pass "every plugin in the tree has a declared payload"

# Every workstation-installable KIND the Ticket names must be represented. A
# list that still parses while a whole category quietly vanished is the failure
# an enumeration is supposed to make impossible.
require_member() {
  local label="$1" asset="$2"
  printf '%s\n' "${declared_workstation[@]}" | grep -qxF "$asset" ||
    fail "the workstation package set carries no $label ($asset)"
}
require_member "dev plugin payload" dist/plugin-dev.payload.tgz
require_member "memory plugin payload" dist/plugin-memory.payload.tgz
require_member "brain plugin payload" dist/plugin-brain.payload.tgz
require_member "internal plugin payload" dist/plugin-internal.payload.tgz
require_member "marketplace projection" dist/marketplace-manifests.tgz
require_member "Gemini local surface" dist/gemini-extension.tgz
require_member "Gemini generated-path validator" dist/validate-gemini-extension.mjs
require_member "Hermes local surface" dist/install-hermes-skills.mjs
require_member "redskilled daemon" dist/redskilled.bundle.min.mjs
require_member "Herdr plugin" dist/herdr-plugin-red-skills.bundle.min.mjs
require_member "VS Code extension" dist/vscode-extension-red-skills-9.9.9.vsix
require_member "Zellij integration" dist/zellij-dashboard.tgz
require_member "offline expander" dist/expand-package-set.mjs
pass "every declared workstation payload kind is present"

# Developer-only artifacts are the opposite failure: an addition that makes the
# workstation contract mean whatever the last release happened to build.
mapfile -t developer_only < <(node scripts/workstation-package-set.mjs --developer-only)
for artifact in \
  dist/benchmark-memory.bundle.min.mjs \
  dist/benchmark-memory.manifest.json \
  dist/benchmark-code-understanding.bundle.min.mjs \
  dist/benchmark-code-understanding.manifest.json \
  dist/release.bundle.min.mjs; do
  printf '%s\n' "${developer_only[@]}" | grep -qxF "$artifact" ||
    fail "$artifact must stay declared developer-only"
done
for artifact in "${developer_only[@]}"; do
  if printf '%s\n' "${declared_workstation[@]}" | grep -qxF "$artifact"; then
    fail "developer-only artifact is inside the workstation package set: $artifact"
  fi
done
pass "developer-only artifacts stay out of the workstation package set"

# The upload is a superset: it also carries the published developer-only
# evidence and the signed manifest with its Sigstore bundle.
mapfile -t release_assets < <(node scripts/workstation-package-set.mjs --github-release --version 9.9.9)
for asset in "${declared_workstation[@]}" dist/package-set.manifest.json dist/package-set.manifest.sigstore.json \
  dist/package-set.manifest.v2.json dist/package-set.manifest.v2.sigstore.json; do
  printf '%s\n' "${release_assets[@]}" | grep -qxF "$asset" || fail "release upload must carry $asset"
done
if printf '%s\n' "${release_assets[@]}" | grep -qxF dist/release.bundle.min.mjs; then
  fail "the release engine bundle travels inside the npm package, not the GitHub Release"
fi
pass "the GitHub Release upload is the workstation set plus its declared extras"

# The npm and Pi transports keep their existing public contracts: this package
# set references them, it does not replace them (Ticket #3977).
for entry in \
  scripts/build-gemini-extension.mjs \
  scripts/validate-gemini-extension.mjs \
  scripts/install-hermes-skills.mjs; do
  node -e '
    const files = require("./packaging/npm/package.json").files;
    if (!files.includes(process.argv[1])) {
      console.error(`packaging/npm/package.json no longer ships ${process.argv[1]}`);
      process.exit(1);
    }
  ' "$entry" || fail "the npm transport must keep shipping $entry"
done
pass "the npm transport keeps its Gemini and Hermes public contract"

# --- network-denied expansion of a complete set (Ticket #3977) ---------------
#
# The release proves this inside `unshare --net` with real cosign. Here the same
# expander runs against a REAL fixture set — the actual plugin trees, the actual
# generated Gemini extension, the actual Hermes installer — with the runtime
# bundles stubbed, so a payload that expands into an unusable shape fails the
# pull request instead of the workstation. Network denial uses a rootless
# namespace when the host allows one; the expander holds no network client
# either way, which the grep above pins.
fixture="$tmp/source"
set_dir="$tmp/set"
expanded="$tmp/expanded"
mkdir -p "$fixture/dist" "$set_dir" "$expanded"
ln -s "$ROOT/plugins" "$fixture/plugins"
for stub in code-nav-mcp redskilled-mcp rsp; do
  printf 'stub %s bundle\n' "$stub" >"$fixture/dist/$stub.bundle.min.mjs"
done

node scripts/build-gemini-extension.mjs --root "$fixture" --output "$tmp/gemini/dev"
node scripts/validate-gemini-extension.mjs --extension "$tmp/gemini/dev" >/dev/null
tar -czf "$set_dir/gemini-extension.tgz" -C "$tmp" gemini
for plugin in dev memory brain internal; do
  tar -czf "$set_dir/plugin-$plugin.payload.tgz" -C "$ROOT" "plugins/$plugin"
done
tar -czf "$set_dir/marketplace-manifests.tgz" -C "$ROOT" \
  .claude-plugin/marketplace.json \
  .agents/plugins/marketplace.json \
  .gemini-plugin/marketplace.json
tar -czf "$set_dir/zellij-dashboard.tgz" -C "$ROOT/apps" zellij-plugin-redskilled
mkdir -p "$tmp/opencode-source/dist/opencode"
printf 'stub opencode projection\n' >"$tmp/opencode-source/dist/opencode/.release-generated"
tar -czf "$set_dir/opencode-host.generated.tgz" -C "$tmp/opencode-source" dist/opencode
for script in \
  verify-package-set.mjs \
  expand-package-set.mjs \
  workstation-package-set.mjs \
  build-gemini-extension.mjs \
  validate-gemini-extension.mjs \
  install-hermes-skills.mjs; do
  cp "scripts/$script" "$set_dir/$script"
done
mapfile -t fixture_assets < <(node scripts/workstation-package-set.mjs --version 9.9.9)
build_args=()
for asset in "${fixture_assets[@]}"; do
  name="$(basename "$asset")"
  [ -e "$set_dir/$name" ] || printf 'stub %s\n' "$name" >"$set_dir/$name"
  build_args+=(--asset "$set_dir/$name")
done
build "$source_commit" "$set_dir/package-set.manifest.json" "${build_args[@]}" >/dev/null
sign_fixture "$set_dir/package-set.manifest.json" "$set_dir/package-set.manifest.sigstore.json"

expand() {
  local into="$1"
  local -a command=(
    node "$set_dir/expand-package-set.mjs"
    --manifest "$set_dir/package-set.manifest.json"
    --bundle "$set_dir/package-set.manifest.sigstore.json"
    --into "$into"
    --version 9.9.9
    --cosign-bin "$tmp/bin/cosign"
  )
  if unshare -rn true >/dev/null 2>&1; then
    unshare -rn -- "${command[@]}"
  else
    printf 'NOTE: this host allows no rootless network namespace; expanding without one\n'
    "${command[@]}"
  fi
}

expand "$expanded" >/dev/null
for materialised in \
  plugins/dev/.claude-plugin/plugin.json \
  plugins/memory/.claude-plugin/plugin.json \
  plugins/brain/.claude-plugin/plugin.json \
  plugins/internal/package.json \
  .claude-plugin/marketplace.json \
  gemini/dev/gemini-extension.json \
  zellij-plugin-redskilled/layouts/red-dashboard.kdl \
  dist/opencode/.release-generated; do
  [ -e "$expanded/$materialised" ] || fail "expansion did not materialise $materialised"
done
pass "a complete package set expands and checks its host surfaces with no network"

# An omitted workstation payload must be refused at expansion time too, not only
# in CI: the operator holding the download is the last reader who can notice.
incomplete="$tmp/incomplete"
mkdir -p "$incomplete/set"
cp "$set_dir"/* "$incomplete/set/" 2>/dev/null || true
rm -f "$incomplete/set/plugin-memory.payload.tgz"
short_args=()
for asset in "${fixture_assets[@]}"; do
  name="$(basename "$asset")"
  if [ "$name" = "plugin-memory.payload.tgz" ]; then continue; fi
  short_args+=(--asset "$incomplete/set/$name")
done
build "$source_commit" "$incomplete/set/package-set.manifest.json" "${short_args[@]}" >/dev/null
sign_fixture "$incomplete/set/package-set.manifest.json" "$incomplete/set/package-set.manifest.sigstore.json"
if node "$incomplete/set/expand-package-set.mjs" \
  --manifest "$incomplete/set/package-set.manifest.json" \
  --bundle "$incomplete/set/package-set.manifest.sigstore.json" \
  --into "$tmp/incomplete-expanded" \
  --version 9.9.9 \
  --cosign-bin "$tmp/bin/cosign" >/dev/null 2>&1; then
  fail "a set missing a workstation payload must be refused"
fi
pass "a set missing a workstation payload is refused"
