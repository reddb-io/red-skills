// refresh-vendored-bundle — writes the vendored release engine AND its claim,
// in one act, so the pair cannot drift apart.
//
// The old repair was two commands a reader had to run in order ("build, then
// copy"), and half of it still left a tree that looked refreshed. Here the
// bundle, its hash, the modules esbuild consumed and the toolchain that minified
// them are produced by one pass: `pnpm -C apps/release vendor:refresh` is the one
// command the guard prints, and running it is what makes the guard green.

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  encodeVendoredProvenance,
  hashBytes,
  hashSourceTree,
  sortSources,
  VENDORED_PROVENANCE_PATH,
  VENDORED_REFRESH_COMMAND,
  type VendoredSourceRecord,
} from "../src/vendored-provenance.js";
import { VENDORED_RELEASE_BUNDLE_PATH } from "../src/workflow-generator.js";

const RELEASE_ROOT = resolve(import.meta.dirname, "..");
const REPO_ROOT = resolve(RELEASE_ROOT, "..", "..");
const BUILD_OUTPUT = join(REPO_ROOT, "dist", "release.bundle.min.mjs");

refresh();

function refresh(): void {
  const scratch = mkdtempSync(join(tmpdir(), "red-vendor-refresh-"));
  try {
    const inputsList = join(scratch, "inputs.txt");
    buildBundle(inputsList);

    const vendored = join(REPO_ROOT, VENDORED_RELEASE_BUNDLE_PATH);
    copyFileSync(BUILD_OUTPUT, vendored);
    // The workflow runs it with `node`, but the file is committed executable and
    // a refresh that silently drops the bit changes the artifact's shape.
    chmodSync(vendored, 0o755);

    const sources = readSourceRecords(inputsList);
    const record = encodeVendoredProvenance({
      bundle: VENDORED_RELEASE_BUNDLE_PATH,
      bundleSha256: hashBytes(readFileSync(vendored)),
      bundleBytes: statSync(vendored).size,
      sourceTreeSha256: hashSourceTree(sources),
      refreshCommand: VENDORED_REFRESH_COMMAND,
      toolchain: { esbuild: esbuildVersion(), node: process.version },
      sources,
    });
    writeFileSync(join(REPO_ROOT, VENDORED_PROVENANCE_PATH), record, "utf8");

    process.stdout.write(
      `refreshed ${VENDORED_RELEASE_BUNDLE_PATH} and ${VENDORED_PROVENANCE_PATH} (${sources.length} source files)\n`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Run the same bundle the `bundle` script runs, asking it to declare its inputs. */
function buildBundle(inputsList: string): void {
  execFileSync(
    process.execPath,
    [
      join(REPO_ROOT, "scripts", "bundle-app.mjs"),
      "--entry", "src/cli.ts",
      "--outfile", BUILD_OUTPUT,
      // Stamped INTO the bundle, so it must match the name the vendored copy is
      // built under.
      "--asset", "release.bundle.min.mjs",
      "--minify",
      "--inputs-out", inputsList,
    ],
    { cwd: RELEASE_ROOT, stdio: "inherit" },
  );
}

function readSourceRecords(inputsList: string): VendoredSourceRecord[] {
  const paths = readFileSync(inputsList, "utf8").split("\n").filter((line) => line.length > 0);
  return sortSources(
    paths.map((path) => ({ path, sha256: hashBytes(readFileSync(join(REPO_ROOT, path))) })),
  );
}

/** The esbuild that actually minified it — never inferred from a manifest range. */
function esbuildVersion(): string {
  return execFileSync("esbuild", ["--version"], { cwd: RELEASE_ROOT, encoding: "utf8" }).trim();
}
