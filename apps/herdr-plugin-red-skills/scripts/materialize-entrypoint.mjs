#!/usr/bin/env node
/**
 * materialize-entrypoint — make the installed plugin root runnable on its own.
 *
 * `herdr plugin install reddb-io/red-skills/apps/herdr-plugin-red-skills` downloads
 * THIS DIRECTORY and nothing above it. The checkout's entry imports `@reddb-io/toon`
 * and `@reddb-io/build-info`, which are workspace links resolved by a `pnpm install`
 * of the 19-package monorepo — so on a machine with no checkout the install
 * completed and every pane died on `No such file or directory` (issue #3060).
 *
 * The cure is the repo's own dist-bundle pattern: every release attaches
 * `herdr-plugin-red-skills.bundle.min.mjs`, one esbuild file with those two
 * dependencies inlined, and this build hook writes it over `bin/red-skills-herdr.mjs`.
 * The bundle IS that file, bundled — same argv surface, same `--version`, same
 * absolute path every pane, action and startup hook in `herdr-plugin.toml` already
 * names — so nothing downstream of the entry has to know which layout it is in.
 *
 * **A checkout materializes nothing.** When the workspace dependencies resolve, the
 * source entry is the better one to run: it is the file a contributor is editing,
 * and `herdr plugin link` exists precisely so that edit is what the panes show.
 *
 * Dependency-free on purpose — it runs at install time, which is exactly when the
 * dependencies are the thing that is missing.
 */
import { chmodSync, copyFileSync, existsSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(ROOT, "bin", "red-skills-herdr.mjs");

/** The dependencies the source entry cannot run without. */
const WORKSPACE_DEPENDENCIES = ["@reddb-io/toon", "@reddb-io/build-info"];

/** The release asset, and the one URL that always names the current one. */
const BUNDLE_ASSET = "herdr-plugin-red-skills.bundle.min.mjs";
const DEFAULT_URL =
  `https://github.com/reddb-io/red-skills/releases/latest/download/${BUNDLE_ASSET}`;

/**
 * The smallest thing that could possibly be the bundle.
 *
 * A 404 page, a redirect stub and an empty file all "download successfully", and
 * each one would install as an entry that fails at the first pane instead of at
 * the install nobody is watching. The name is in the bundle's own usage text.
 */
const MIN_BYTES = 10_000;
const MARKER = "red-skills-herdr";

/**
 * True when the source entry beside this script can load what it imports.
 *
 * Asked by IMPORTING them, from this file, which sits in the same plugin root the
 * entry does — so the question is the one that matters ("can the checkout's entry
 * run here") rather than a proxy for it. `require.resolve` is the wrong instrument
 * twice over: `@reddb-io/toon` is ESM with an `import`-only exports map, so a
 * present, working dependency answers "missing", and a directory that exists says
 * nothing about whether Node will load it.
 */
export async function workspaceDependenciesResolve() {
  for (const dependency of WORKSPACE_DEPENDENCIES) {
    try {
      await import(dependency);
    } catch {
      return false;
    }
  }
  return true;
}

/** Refuse bytes that are not the artifact, naming which check said so. PURE. */
export function rejectionReason(bytes, text) {
  if (bytes.length < MIN_BYTES) return `${bytes.length} bytes is too small to be ${BUNDLE_ASSET}`;
  if (!text.includes(MARKER)) return `the downloaded bytes do not mention ${MARKER}`;
  return null;
}

async function download(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status} ${response.statusText}`);
  return Buffer.from(await response.arrayBuffer());
}

async function main() {
  if (await workspaceDependenciesResolve()) {
    process.stdout.write(
      "red-skills: workspace dependencies resolve — running from the checkout, nothing to materialize\n",
    );
    return 0;
  }

  const url = process.env.RED_SKILLS_HERDR_BUNDLE_URL || DEFAULT_URL;
  process.stdout.write(`red-skills: no workspace here; fetching ${url}\n`);

  let bundle;
  try {
    bundle = await download(url);
  } catch (error) {
    process.stderr.write(
      `red-skills: could not fetch ${BUNDLE_ASSET}: ${error?.message ?? error}\n` +
        "  the plugin cannot run from this directory without it.\n" +
        `  fetch it by hand into bin/red-skills-herdr.mjs, or install from a checkout with\n` +
        "  `pnpm install && herdr plugin link apps/herdr-plugin-red-skills`.\n",
    );
    return 1;
  }

  const rejected = rejectionReason(bundle, bundle.toString("utf8"));
  if (rejected !== null) {
    process.stderr.write(`red-skills: refusing the download from ${url}: ${rejected}\n`);
    return 1;
  }

  // Written beside the entry and renamed over it, so an interrupted install
  // leaves the source entry — which fails loudly and legibly — rather than half
  // a bundle, which fails as a syntax error nobody can place.
  const staging = mkdtempSync(join(tmpdir(), "red-skills-herdr-"));
  const staged = join(staging, "red-skills-herdr.mjs");
  try {
    writeFileSync(staged, bundle);
    chmodSync(staged, existsSync(ENTRY) ? statSync(ENTRY).mode : 0o755);
    try {
      renameSync(staged, ENTRY);
    } catch {
      // A staging dir on another filesystem cannot be renamed across; the copy
      // is not atomic, and it is the only move left.
      copyFileSync(staged, ENTRY);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  process.stdout.write(
    `red-skills: materialized ${bundle.length} bytes into bin/red-skills-herdr.mjs\n`,
  );
  return 0;
}

// Only run when invoked as a program: the suite imports the two pure halves.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
    .then((code) => {
      if (code !== 0) process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`red-skills: ${error?.stack ?? error}\n`);
      process.exitCode = 1;
    });
}
