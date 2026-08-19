#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MEMORY_TOKENIZER_ASSET = "memory-tokenizer.asset.cjs";

function parseArgs(argv) {
  const args = { root: process.cwd(), core: "", plugins: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== "--root" && flag !== "--core" && flag !== "--plugins") {
      throw new Error(`unknown argument: ${flag}`);
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`${flag} requires a value`);
    args[flag.slice(2)] = value;
    index += 1;
  }
  if (!args.core || !args.plugins) {
    throw new Error("usage: check-npm-tarball-boundaries.mjs --core <tarball> --plugins <directory> [--root <repo>]");
  }
  return args;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function materializeListing(tarball) {
  const result = spawnSync("tar", ["-tzf", tarball], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`cannot list ${tarball}: ${result.stderr.trim() || `tar exited ${result.status}`}`);
  }
  return result.stdout.split("\n").filter(Boolean);
}

function requireEntry(listing, expected, label) {
  if (!listing.includes(expected)) {
    throw new Error(`${label} tarball missing ${expected}`);
  }
}

/**
 * Every bundle `prepare.mjs` stages into the core package, read from that file
 * so the two cannot drift. Hand-listing them is what let six of them — the
 * `redskilled-mcp` server every agent launches among them — lose their
 * publish-time presence guard when the per-plugin bundles were contracted out
 * (#3957): the absence check for plugins landed, and the presence check for
 * what the core still carries did not come with it. A bin shim passing is not
 * the same fact: the shim forwards to a bundle that has to be in the tarball.
 */
function stagedCoreBundles(root) {
  const prepare = readFileSync(join(root, "packaging/npm/scripts/prepare.mjs"), "utf8");
  const names = [...prepare.matchAll(/dest:\s*"([^"]+\.bundle\.min\.mjs)"/g)].map((m) => m[1]);
  if (names.length === 0) {
    throw new Error("check-npm-tarball-boundaries: prepare.mjs staged no bundles — the parse is stale");
  }
  return names;
}

function checkCore(root, tarball) {
  const listing = materializeListing(tarball);
  const packageJson = readJson(join(root, "packaging/npm/package.json"));
  const required = [
    ...Object.values(packageJson.bin).map((path) => `package/${path}`),
    "package/.agents/plugins/marketplace.json",
    "package/.claude-plugin/marketplace.json",
    "package/.gemini-plugin/marketplace.json",
    "package/scripts/generate-codex-manifests.mjs",
    "package/scripts/generate-gemini-manifests.mjs",
    "package/scripts/generate-pi-manifests.mjs",
    "package/scripts/build-gemini-extension.mjs",
    "package/scripts/validate-gemini-extension.mjs",
    "package/scripts/install-hermes-skills.mjs",
    ...stagedCoreBundles(root).map((name) => `package/dist/${name}`),
  ];
  for (const expected of required) requireEntry(listing, expected, "core npm");

  for (const plugin of pluginManifests(root)) {
    const unexpected = `package/dist/${plugin.name}.bundle.min.mjs`;
    if (listing.includes(unexpected)) {
      throw new Error(`core npm tarball unexpectedly contains ${unexpected}`);
    }
  }

  const unexpectedTokenizer = `package/dist/${MEMORY_TOKENIZER_ASSET}`;
  if (listing.includes(unexpectedTokenizer)) {
    throw new Error(`core npm tarball unexpectedly contains ${unexpectedTokenizer}`);
  }

  const forbidden = listing.find(
    (entry) => entry.startsWith("package/apps/") || entry.startsWith("package/packages/"),
  );
  if (forbidden) {
    throw new Error(`core npm tarball crosses into the monorepo runtime/shared tree: ${forbidden}`);
  }
}

function npmTarballPrefix(packageName) {
  return `${packageName.replace(/^@/, "").replaceAll("/", "-")}-`;
}

function pluginManifests(root) {
  const pluginsRoot = join(root, "plugins");
  return readdirSync(pluginsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readJson(join(pluginsRoot, entry.name, ".claude-plugin/plugin.json")))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * A plugin ships a runtime bundle iff its app actually EMITS one.
 *
 * The presence of `apps/<name>/` was a good enough proxy until #4031 deleted the
 * dev CLI bundle: `apps/dev` still exists — it holds the MCP adapter and the
 * cores — but it no longer emits `dev.bundle.min.mjs`, so the proxy demanded a
 * file nothing builds. Reading the app's own `bundle` script for the emitted
 * name keeps this check honest as apps gain and lose bundles.
 */
function pluginHasRuntime(root, pluginName) {
  const manifest = join(root, "apps", pluginName, "package.json");
  if (!existsSync(manifest)) return false;
  const scripts = readJson(manifest).scripts ?? {};
  return Object.values(scripts).some(
    (command) => typeof command === "string" && command.includes(`${pluginName}.bundle.min.mjs`),
  );
}

function checkPlugins(root, tarballsDir) {
  const tarballs = readdirSync(tarballsDir).filter((entry) => entry.endsWith(".tgz"));
  for (const plugin of pluginManifests(root)) {
    const packageName = `@reddb-io/red-skills-${plugin.name}`;
    const prefix = npmTarballPrefix(packageName);
    const matches = tarballs.filter((entry) => entry.startsWith(prefix));
    if (matches.length !== 1) {
      throw new Error(`${packageName}: expected one packed tarball, found ${matches.length}`);
    }

    const listing = materializeListing(join(tarballsDir, matches[0]));
    const skill = listing.find(
      (entry) => entry.startsWith("package/skills/") && entry.endsWith("/SKILL.md"),
    );
    if (!skill) throw new Error(`${packageName} tarball carries no published skills`);
    // A plugin carries its runtime bundle iff it has a runtime app
    // (apps/<name>); `internal` is skills-only, and demanding a bundle nothing
    // builds refused the v3.19.1 publish. The inverse is refused too, so a
    // stray bundle cannot ride a skills-only package.
    const bundle = `package/dist/${plugin.name}.bundle.min.mjs`;
    if (pluginHasRuntime(root, plugin.name)) {
      requireEntry(listing, bundle, packageName);
    } else if (listing.includes(bundle)) {
      throw new Error(`${packageName} is skills-only but its tarball carries ${bundle}`);
    }
    if (plugin.name === "memory") {
      requireEntry(listing, `package/dist/${MEMORY_TOKENIZER_ASSET}`, packageName);
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  checkCore(args.root, args.core);
  checkPlugins(args.root, args.plugins);
  process.stdout.write("npm tarball boundaries ok\n");
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
