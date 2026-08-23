#!/usr/bin/env node

// The declared workstation package set (Spec #3973, Ticket #3977).
//
// A RedSkills release attaches two kinds of artifact to one GitHub Release:
// what a WORKSTATION installs, and what only this repository's own developers
// consume. Both used to be hand-kept bash arrays inside red-publish.yml — one
// for the signed package set, one for the upload — so a new payload landed in
// whichever array its author happened to edit. That drift is invisible until an
// operator expands the set on a machine with no network and finds a host with
// no plugin payload to register.
//
// This module is the ONE enumeration. The release workflow derives both arrays
// from it, and scripts/test-package-set-contract.sh pins it against an
// independent literal list, so adding or dropping a payload is a deliberate
// two-file change rather than a silent omission.

import { fileURLToPath } from "node:url";

/**
 * One workstation-installable payload.
 *
 * `asset` is the dist path the release builds; `{version}` is substituted with
 * the release version. `expandsTo` names the paths an archive payload
 * materialises relative to an expansion root — the expander asserts them, so a
 * tarball packed from the wrong `-C` fails the release instead of the operator.
 */
export const WORKSTATION_PAYLOADS = [
  // The four plugin definition trees every host registers. Without them a
  // network-denied expansion yields runtimes with nothing to run.
  { asset: "dist/plugin-dev.payload.tgz", kind: "plugin-payload", expandsTo: ["plugins/dev"] },
  { asset: "dist/plugin-memory.payload.tgz", kind: "plugin-payload", expandsTo: ["plugins/memory"] },
  { asset: "dist/plugin-brain.payload.tgz", kind: "plugin-payload", expandsTo: ["plugins/brain"] },
  { asset: "dist/plugin-internal.payload.tgz", kind: "plugin-payload", expandsTo: ["plugins/internal"] },

  // Canonical host projections and the generators that produce them. The Claude
  // manifest is the source; the Codex and Gemini manifests are its projections.
  {
    asset: "dist/marketplace-manifests.tgz",
    kind: "host-projection",
    expandsTo: [".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json", ".gemini-plugin/marketplace.json"],
  },
  { asset: "dist/opencode-host.bundle.min.mjs", kind: "host-generator" },
  { asset: "dist/opencode-host.generated.tgz", kind: "host-projection", expandsTo: ["dist/opencode"] },
  // Gemini (#3975): the generated extension is shipped already built AND the
  // generator plus its generated-path validator ride along, so an operator can
  // re-generate and re-validate from the expanded plugin payloads offline.
  { asset: "dist/gemini-extension.tgz", kind: "host-projection", expandsTo: ["gemini/dev"] },
  { asset: "dist/build-gemini-extension.mjs", kind: "host-generator" },
  { asset: "dist/validate-gemini-extension.mjs", kind: "host-generator" },
  // Hermes (#3976): the installer reads `<source>/plugins/dev`, which the dev
  // plugin payload above materialises.
  { asset: "dist/install-hermes-skills.mjs", kind: "host-generator" },

  // Runtime bundles, each with the checksum manifest its dynamic fetch verifies.
  // No `dev.bundle.min.mjs`: #4031 deleted the dev CLI (ADR 0147 §1) and the
  // dev plugin now reaches its MCP through the npm package. A set that still
  // demanded it would sign a payload the release cannot build.
  { asset: "dist/redskilled-mcp.bundle.min.mjs", kind: "runtime-bundle" },
  { asset: "dist/code-nav.bundle.min.mjs", kind: "runtime-bundle" },
  { asset: "dist/code-nav.manifest.json", kind: "runtime-bundle" },
  { asset: "dist/memory.bundle.min.mjs", kind: "runtime-bundle" },
  { asset: "dist/memory-mcp.bundle.min.mjs", kind: "runtime-bundle" },
  { asset: "dist/memory-runtime-manifest.json", kind: "runtime-bundle" },
  { asset: "dist/brain.bundle.min.mjs", kind: "runtime-bundle" },
  { asset: "dist/brain-mcp.bundle.min.mjs", kind: "runtime-bundle" },
  { asset: "dist/brain-runtime-manifest.json", kind: "runtime-bundle" },
  { asset: "dist/rsp.bundle.min.mjs", kind: "runtime-bundle" },
  { asset: "dist/rsp-core.bundle.min.mjs", kind: "runtime-bundle" },

  // The host-scoped daemon (ADR 0130).
  { asset: "dist/redskilled.bundle.min.mjs", kind: "daemon" },
  // The prompt host's statusline renderer, split out of the daemon bundle so a
  // per-render invocation does not pay the daemon's import-time initialization.
  { asset: "dist/statusline.bundle.min.mjs", kind: "daemon" },

  // Companion surfaces installed by hand rather than resolved by a launcher, so
  // the release is the only place they can come from (#3060).
  { asset: "dist/herdr-plugin-red-skills.bundle.min.mjs", kind: "companion-surface" },
  { asset: "dist/vscode-extension-red-skills-{version}.vsix", kind: "companion-surface" },
  { asset: "dist/zellij-dashboard.tgz", kind: "terminal-integration", expandsTo: ["zellij-plugin-redskilled"] },

  // Everything a network-denied expansion needs to check itself.
  { asset: "dist/verify-package-set.mjs", kind: "verifier-input" },
  { asset: "dist/expand-package-set.mjs", kind: "verifier-input" },
  // The expander reads this enumeration to know what an expansion owes, so the
  // completeness check travels with the set instead of living only in CI.
  { asset: "dist/workstation-package-set.mjs", kind: "verifier-input" },
];

/**
 * Artifacts the release builds that the workstation set must NEVER carry.
 * `published` says whether the GitHub Release still attaches the file: the
 * benchmarks are downloadable evidence for this repository's own measurements,
 * and the release engine bundle travels only inside the npm package.
 */
export const DEVELOPER_ONLY_ARTIFACTS = [
  { asset: "dist/benchmark-memory.bundle.min.mjs", published: true },
  { asset: "dist/benchmark-memory.manifest.json", published: true },
  { asset: "dist/benchmark-code-understanding.bundle.min.mjs", published: true },
  { asset: "dist/benchmark-code-understanding.manifest.json", published: true },
  { asset: "dist/release.bundle.min.mjs", published: false },
];

/** The signed manifest and its Sigstore bundle: attached, never members of the set they describe. */
/**
 * The manifests the Release attaches, each with its own signature.
 *
 * Two, while the readers migrate (#4005): `package-set.manifest.json` keeps the
 * canonical name and the v1 shape every existing verifier mirrors, and the v2
 * manifest — the one whose identity covers version, channel and targets — rides
 * beside it. The canonical name flips when the readers have flipped.
 */
export const PACKAGE_SET_SIGNATURE_ASSETS = [
  "dist/package-set.manifest.json",
  "dist/package-set.manifest.sigstore.json",
  "dist/package-set.manifest.v2.json",
  "dist/package-set.manifest.v2.sigstore.json",
];

const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

function resolveAsset(asset, version) {
  if (!asset.includes("{version}")) return asset;
  if (!version) throw new Error(`--version is required to resolve ${asset}`);
  return asset.replaceAll("{version}", version);
}

/** The complete workstation package set, in declaration order. */
export function workstationAssets(version) {
  return WORKSTATION_PAYLOADS.map((payload) => resolveAsset(payload.asset, version));
}

/** The plugin definition payloads, one per plugin the marketplace ships. */
export function pluginPayloads() {
  return WORKSTATION_PAYLOADS.filter((payload) => payload.kind === "plugin-payload").map((payload) => payload.asset);
}

/** The archive payloads, with the paths each one must materialise. */
export function archivePayloads(version) {
  return WORKSTATION_PAYLOADS.filter((payload) => Array.isArray(payload.expandsTo)).map((payload) => ({
    asset: resolveAsset(payload.asset, version),
    expandsTo: payload.expandsTo,
  }));
}

/** Every file the tag's GitHub Release attaches. */
export function githubReleaseAssets(version) {
  return [
    ...workstationAssets(version),
    ...DEVELOPER_ONLY_ARTIFACTS.filter((artifact) => artifact.published).map((artifact) => artifact.asset),
    ...PACKAGE_SET_SIGNATURE_ASSETS,
  ];
}

/**
 * The platform tokens a release's package set is built for (#4005). Declared
 * here, beside the payload enumeration, because the release workflow must
 * never spell a target in a literal of its own: the set and the targets it
 * claims come from the same one place.
 */
export const WORKSTATION_TARGETS = ["linux-x64", "windows-x64"];

function parseArgs(argv) {
  const options = { mode: "workstation", version: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--version") {
      const value = argv[index + 1];
      if (!value) throw new Error("--version requires a value");
      if (!VERSION.test(value)) throw new Error(`--version must be a bare semver, got ${JSON.stringify(value)}`);
      options.version = value;
      index += 1;
      continue;
    }
    if (
      argument === "--workstation" ||
      argument === "--developer-only" ||
      argument === "--github-release" ||
      argument === "--archives" ||
      argument === "--plugin-payloads" ||
      argument === "--targets"
    ) {
      options.mode = argument.slice(2);
      continue;
    }
    throw new Error(`unknown or incomplete argument: ${argument}`);
  }
  return options;
}

export function render(options) {
  if (options.mode === "developer-only") return DEVELOPER_ONLY_ARTIFACTS.map((artifact) => artifact.asset);
  if (options.mode === "github-release") return githubReleaseAssets(options.version);
  if (options.mode === "plugin-payloads") return pluginPayloads();
  if (options.mode === "targets") return [...WORKSTATION_TARGETS];
  if (options.mode === "archives") {
    return archivePayloads(options.version).map((payload) => `${payload.asset}\t${payload.expandsTo.join(",")}`);
  }
  return workstationAssets(options.version);
}

export function main(argv = process.argv.slice(2)) {
  const lines = render(parseArgs(argv));
  process.stdout.write(lines.length === 0 ? "" : `${lines.join("\n")}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`workstation package set failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
