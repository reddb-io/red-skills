#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PACKAGE_SET_SCHEMA = "red.package-set.v1";

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
 * carries no build time, release URL, or input ordering: the source commit and
 * exact local artifact bytes are the complete identity.
 */
export function createPackageSet({ sourceCommit, artifacts }) {
  assertCommit(sourceCommit);
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
  const options = { assets: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--asset" && value) {
      options.assets.push(value);
      index += 1;
    } else if (argument === "--source-commit" && value) {
      options.sourceCommit = value;
      index += 1;
    } else if (argument === "--out" && value) {
      options.out = value;
      index += 1;
    } else {
      throw new Error(`unknown or incomplete argument: ${argument}`);
    }
  }
  if (!options.sourceCommit) throw new Error("--source-commit is required");
  if (!options.out) throw new Error("--out is required");
  return options;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const manifest = createPackageSet({
    sourceCommit: options.sourceCommit,
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
