#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PACKAGE_SET_SCHEMA = "red.package-set.v2";

/**
 * The closed channel vocabulary (#4005). A consumer that reads `channel` has to
 * be able to decide on it, so the value is one of a named set rather than free
 * text: `stable` is what the release publishes, `canary` is the opt-in dist-tag
 * this repository moves after the fact, `next` is the pre-release channel
 * red-dev resolves, and `pinned` is a set built at one exact version with no
 * channel to follow.
 */
export const PACKAGE_SET_CHANNELS = ["stable", "canary", "next", "pinned"];

/**
 * The platform tokens a set may declare. A depot is target-specific (red-dev
 * ADR 0010) and must refuse a set built for another target, which it can only
 * do if the target is INSIDE the signed identity — a target-neutral manifest
 * leaves an unknown schema as the only gate.
 */
export const PACKAGE_SET_TARGETS = ["linux-x64", "windows-x64"];

const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertCommit(value, label = "source commit") {
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${label} must be a lowercase 40-character git commit`);
  }
}

export function packageSetIdentityBytes(identity) {
  return Buffer.from(`${JSON.stringify(identity)}\n`);
}

/**
 * Build the deterministic package-set manifest model. The identity deliberately
 * carries no build time, release URL, or input ordering: the source commit,
 * the version, channel and targets it was built for, and the exact local
 * artifact bytes are the complete identity. **A fact a consumer must decide on
 * belongs inside the signature** — red-dev read the version from
 * `tree/package.json`, i.e. from outside the bytes anybody signed (#4005).
 */
export function createPackageSet({ sourceCommit, version, channel, targets, artifacts }) {
  assertCommit(sourceCommit);
  if (typeof version !== "string" || !VERSION.test(version)) {
    throw new Error("version must be a semantic version, e.g. 4.0.0");
  }
  if (!PACKAGE_SET_CHANNELS.includes(channel)) {
    throw new Error(`channel must be one of ${PACKAGE_SET_CHANNELS.join(", ")}`);
  }
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error("at least one --target is required");
  }
  for (const target of targets) {
    if (!PACKAGE_SET_TARGETS.includes(target)) {
      throw new Error(`unknown target: ${String(target)} (known: ${PACKAGE_SET_TARGETS.join(", ")})`);
    }
  }
  const declaredTargets = [...new Set(targets)].sort((left, right) => left.localeCompare(right, "en"));
  if (declaredTargets.length !== targets.length) throw new Error("duplicate target");
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new Error("at least one --asset is required");
  }

  const declared = artifacts.map((input) => {
    const path = resolve(typeof input === "string" ? input : input.path);
    const artifactCommit = typeof input === "string" ? sourceCommit : (input.sourceCommit ?? sourceCommit);
    assertCommit(artifactCommit, `source commit for ${basename(path)}`);
    const info = statSync(path);
    if (!info.isFile()) throw new Error(`artifact is not a regular file: ${path}`);
    const bytes = readFileSync(path);
    return {
      name: basename(path),
      sourceCommit: artifactCommit,
      size: info.size,
      sha256: sha256(bytes),
    };
  });

  declared.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (let index = 1; index < declared.length; index += 1) {
    if (declared[index - 1].name === declared[index].name) {
      throw new Error(`duplicate artifact name: ${declared[index].name}`);
    }
  }

  const identity = {
    schema: PACKAGE_SET_SCHEMA,
    sourceCommit,
    version,
    channel,
    targets: declaredTargets,
    artifacts: declared,
  };
  return {
    ...identity,
    wholeSetDigest: sha256(packageSetIdentityBytes(identity)),
  };
}

export function encodePackageSet(manifest) {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
}

function parseArgs(argv) {
  const options = { assets: [], targets: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--asset" && value) {
      options.assets.push(value);
      index += 1;
    } else if (argument === "--source-commit" && value) {
      options.sourceCommit = value;
      index += 1;
    } else if (argument === "--release-version" && value) {
      options.version = value;
      index += 1;
    } else if (argument === "--channel" && value) {
      options.channel = value;
      index += 1;
    } else if (argument === "--target" && value) {
      options.targets.push(value);
      index += 1;
    } else if (argument === "--out" && value) {
      options.out = value;
      index += 1;
    } else {
      throw new Error(`unknown or incomplete argument: ${argument}`);
    }
  }
  if (!options.sourceCommit) throw new Error("--source-commit is required");
  if (!options.version) throw new Error("--release-version is required");
  if (!options.channel) throw new Error("--channel is required");
  if (options.targets.length === 0) throw new Error("at least one --target is required");
  if (!options.out) throw new Error("--out is required");
  return options;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const manifest = createPackageSet({
    sourceCommit: options.sourceCommit,
    version: options.version,
    channel: options.channel,
    targets: options.targets,
    artifacts: options.assets,
  });
  const out = resolve(options.out);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, encodePackageSet(manifest));
  process.stdout.write(`${manifest.wholeSetDigest}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`package-set build failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
