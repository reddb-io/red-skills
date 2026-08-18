#!/usr/bin/env node

// Expand and check a downloaded workstation package set with the network gone
// (Spec #3973, Ticket #3977).
//
// scripts/verify-package-set.mjs answers "are these bytes the signed ones?".
// That is necessary and not sufficient: a set can be perfectly signed and still
// be missing the plugin payload a host must register, or carry a tarball packed
// from the wrong directory so it expands somewhere nobody looks. This expander
// answers the operator's actual question — "can this machine, with no network,
// install RedSkills from what it downloaded?" — by verifying the signature,
// expanding every archive payload, asserting each materialises what the
// enumeration declares, and driving the Gemini and Hermes local surfaces
// through their own validators against the expanded tree.
//
// It holds no network client BY CONSTRUCTION and shells out to `tar` and to the
// released scripts sitting beside the manifest; scripts/test-package-set-contract.sh
// greps this file for a network client the same way it greps the verifier.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEVELOPER_ONLY_ARTIFACTS, archivePayloads, workstationAssets } from "./workstation-package-set.mjs";

const VSIX = /^vscode-extension-red-skills-[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?\.vsix$/;

function fail(message) {
  throw new Error(message);
}

function run(command, args, label) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) fail(`${label} could not run: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim();
    fail(`${label} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout ?? "";
}

/**
 * The declared set is what an expansion owes. A missing payload is the failure
 * this whole exercise exists to catch; a developer-only artifact inside the
 * signed set is the opposite failure and just as wrong, because it makes the
 * workstation contract mean whatever the last release happened to build.
 */
function assertCompleteSet(manifest, version) {
  const present = new Set(manifest.artifacts.map((artifact) => artifact.name));
  const missing = [];
  for (const asset of workstationAssets(version || "0.0.0")) {
    const name = basename(asset);
    if (asset.includes("vscode-extension-red-skills-") && !version) {
      if (![...present].some((candidate) => VSIX.test(candidate))) missing.push("vscode-extension-red-skills-<version>.vsix");
      continue;
    }
    if (!present.has(name)) missing.push(name);
  }
  if (missing.length > 0) fail(`package set is missing workstation payload(s): ${missing.join(", ")}`);

  const developerOnly = DEVELOPER_ONLY_ARTIFACTS.map((artifact) => basename(artifact.asset)).filter((name) => present.has(name));
  if (developerOnly.length > 0) {
    fail(`package set carries developer-only artifact(s): ${developerOnly.join(", ")}`);
  }
}

function expandArchives(manifest, root, into, version) {
  const present = new Set(manifest.artifacts.map((artifact) => artifact.name));
  for (const payload of archivePayloads(version || "0.0.0")) {
    const name = basename(payload.asset);
    if (!present.has(name)) fail(`archive payload is missing from the manifest: ${name}`);
    // `-p` keeps the mode bits a host reads (the Gemini hook must stay
    // executable); `--no-same-owner` refuses to chown, which is both what an
    // operator expanding into their own tree wants and the only thing that
    // works inside a rootless namespace.
    run("tar", ["-xzf", join(root, name), "-p", "--no-same-owner", "-C", into], `expanding ${name}`);
    for (const expected of payload.expandsTo) {
      if (!existsSync(join(into, expected))) fail(`${name} did not materialise ${expected}`);
    }
  }
}

/**
 * Generated-path validation for the two local host surfaces added by #3975 and
 * #3976. Both run against the EXPANDED tree, not the repository, so a payload
 * that expands into an unusable shape fails here rather than on a workstation.
 */
function checkLocalHostSurfaces(root, into) {
  run("node", [join(root, "validate-gemini-extension.mjs"), "--extension", join(into, "gemini", "dev")], "Gemini extension validation");

  const hermesHome = mkdtempSync(join(into, ".hermes-home-"));
  try {
    const installer = join(root, "install-hermes-skills.mjs");
    run("node", [installer, "--install", "--source", into, "--home", hermesHome], "Hermes skills install");
    run("node", [installer, "--verify", "--source", into, "--home", hermesHome], "Hermes skills verify");
    run("node", [installer, "--uninstall", "--home", hermesHome], "Hermes skills uninstall");
  } finally {
    rmSync(hermesHome, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const options = { version: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    const flags = {
      "--manifest": "manifestPath",
      "--bundle": "bundlePath",
      "--into": "into",
      "--verifier": "verifierPath",
      "--cosign-bin": "cosignBin",
      "--trusted-root": "trustedRootPath",
      "--certificate-identity-regexp": "identityRegexp",
      "--version": "version",
    };
    const key = flags[argument];
    if (!key || !value) fail(`unknown or incomplete argument: ${argument}`);
    options[key] = key === "cosignBin" || key === "identityRegexp" || key === "version" ? value : resolve(value);
    index += 1;
  }
  if (!options.manifestPath) fail("--manifest is required");
  if (!options.bundlePath) fail("--bundle is required");
  if (!options.into) fail("--into is required");
  return options;
}

function verifySignedBytes(options, root) {
  const verifier = options.verifierPath ?? join(root, "verify-package-set.mjs");
  if (!existsSync(verifier)) fail(`verifier is missing: ${verifier}`);
  const args = [verifier, "--manifest", options.manifestPath, "--bundle", options.bundlePath];
  if (options.cosignBin) args.push("--cosign-bin", options.cosignBin);
  if (options.trustedRootPath) args.push("--trusted-root", options.trustedRootPath);
  if (options.identityRegexp) args.push("--certificate-identity-regexp", options.identityRegexp);
  run(process.execPath, args, "package-set verification");
}

export function expandPackageSet(options) {
  const root = dirname(options.manifestPath);
  verifySignedBytes(options, root);
  const manifest = JSON.parse(readFileSync(options.manifestPath, "utf8"));
  assertCompleteSet(manifest, options.version);
  mkdirSync(options.into, { recursive: true });
  expandArchives(manifest, root, options.into, options.version);
  checkLocalHostSurfaces(root, options.into);
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const manifest = expandPackageSet(parseArgs(process.argv.slice(2)));
    process.stdout.write(`expanded and checked package set ${manifest.wholeSetDigest}\n`);
  } catch (error) {
    process.stderr.write(`package-set expansion failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
