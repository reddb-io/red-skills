#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const SCHEMA = "red.package-set.v1";
const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const EXPECTED_KEYS = ["schema", "sourceCommit", "artifacts", "wholeSetDigest"];
const EXPECTED_ARTIFACT_KEYS = ["name", "sourceCommit", "size", "sha256"];
const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
const RELEASE_IDENTITY =
  "^https://github\\.com/reddb-io/red-skills/\\.github/workflows/red-publish\\.yml@refs/heads/main$" +
  "|^https://github\\.com/reddb-io/red-skills/\\.github/workflows/red-publish\\.yml@refs/tags/v[0-9]+\\.[0-9]+\\.[0-9]+$";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value)) === JSON.stringify(expected)
  );
}

function fail(message) {
  throw new Error(message);
}

function verifySignature({ manifestPath, bundlePath, cosignBin, identityRegexp, trustedRootPath }) {
  if (!existsSync(bundlePath)) fail("signature bundle is missing");
  if (trustedRootPath && !existsSync(trustedRootPath)) fail("trusted root is missing");
  const result = spawnSync(
    cosignBin,
    [
      "verify-blob",
      "--offline",
      "--bundle",
      bundlePath,
      "--certificate-identity-regexp",
      identityRegexp,
      "--certificate-oidc-issuer",
      GITHUB_ISSUER,
      // The Sigstore trust roots (Fulcio, Rekor, CT log keys) are the one input
      // the bundle cannot carry. cosign fetches them through TUF, verified
      // against its embedded root, when no --trusted-root is given; a host with
      // no network passes the trusted_root.json a prior `cosign initialize`
      // cached.
      ...(trustedRootPath ? ["--trusted-root", trustedRootPath] : []),
      manifestPath,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.error) fail(`signature verifier could not run: ${result.error.message}`);
  if (result.status !== 0) {
    // cosign's own reason is the only thing that separates "wrong signer",
    // "tampered manifest", and "verifier could not reach its trust roots";
    // swallowing it left the v3.19.0 release log with a bare "invalid".
    const detail = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim();
    fail(`manifest signature is invalid${detail ? `: ${detail}` : ""}`);
  }
}

function parseAndValidateManifest(manifestPath) {
  const bytes = readFileSync(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("manifest is not valid JSON");
  }
  if (!sameKeys(manifest, EXPECTED_KEYS)) fail("manifest shape or key order is not canonical");
  if (manifest.schema !== SCHEMA) fail(`unsupported manifest schema: ${String(manifest.schema)}`);
  if (!COMMIT.test(manifest.sourceCommit)) fail("manifest source commit is invalid");
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    fail("manifest must declare at least one artifact");
  }
  if (!SHA256.test(manifest.wholeSetDigest)) fail("whole-set digest is invalid");

  let priorName = "";
  for (const artifact of manifest.artifacts) {
    if (!sameKeys(artifact, EXPECTED_ARTIFACT_KEYS)) fail("artifact shape or key order is not canonical");
    if (
      typeof artifact.name !== "string" ||
      artifact.name.length === 0 ||
      artifact.name === "." ||
      artifact.name === ".." ||
      basename(artifact.name) !== artifact.name
    ) {
      fail("artifact name must be one local basename");
    }
    if (priorName && priorName.localeCompare(artifact.name, "en") >= 0) {
      fail("artifact names must be unique and sorted");
    }
    priorName = artifact.name;
    if (artifact.sourceCommit !== manifest.sourceCommit) {
      fail(`artifact ${artifact.name} belongs to a different source commit`);
    }
    if (!Number.isSafeInteger(artifact.size) || artifact.size < 0) {
      fail(`artifact ${artifact.name} has an invalid size`);
    }
    if (!SHA256.test(artifact.sha256)) fail(`artifact ${artifact.name} has an invalid checksum`);
  }

  const identity = {
    schema: manifest.schema,
    sourceCommit: manifest.sourceCommit,
    artifacts: manifest.artifacts,
  };
  const expectedDigest = sha256(Buffer.from(`${JSON.stringify(identity)}\n`));
  if (manifest.wholeSetDigest !== expectedDigest) fail("whole-set digest does not match the manifest identity");
  const canonicalBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  if (!bytes.equals(canonicalBytes)) fail("manifest bytes are not canonical");
  return manifest;
}

function verifyArtifacts(manifest, manifestPath) {
  const root = dirname(manifestPath);
  for (const artifact of manifest.artifacts) {
    const path = join(root, artifact.name);
    if (!existsSync(path)) fail(`declared artifact is missing: ${artifact.name}`);
    const info = statSync(path);
    if (!info.isFile()) fail(`declared artifact is not a regular file: ${artifact.name}`);
    if (info.size !== artifact.size) fail(`artifact size mismatch: ${artifact.name}`);
    if (sha256(readFileSync(path)) !== artifact.sha256) fail(`artifact checksum mismatch: ${artifact.name}`);
  }
}

function parseArgs(argv) {
  const options = { cosignBin: "cosign", identityRegexp: RELEASE_IDENTITY };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--manifest" && value) {
      options.manifestPath = resolve(value);
      index += 1;
    } else if (argument === "--bundle" && value) {
      options.bundlePath = resolve(value);
      index += 1;
    } else if (argument === "--cosign-bin" && value) {
      options.cosignBin = value;
      index += 1;
    } else if (argument === "--trusted-root" && value) {
      options.trustedRootPath = resolve(value);
      index += 1;
    } else if (argument === "--certificate-identity-regexp" && value) {
      // Smoke/test override only: the release verifier default pins the
      // red-publish workflow identity. A pull-request smoke signs under its
      // own workflow ref and must say so explicitly to be accepted.
      options.identityRegexp = value;
      index += 1;
    } else {
      fail(`unknown or incomplete argument: ${argument}`);
    }
  }
  if (!options.manifestPath) fail("--manifest is required");
  if (!options.bundlePath) fail("--bundle is required");
  return options;
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.manifestPath)) fail("manifest is missing");
  verifySignature(options);
  const manifest = parseAndValidateManifest(options.manifestPath);
  verifyArtifacts(manifest, options.manifestPath);
  process.stdout.write(`verified package set ${manifest.wholeSetDigest}\n`);
} catch (error) {
  process.stderr.write(`package-set verification failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
