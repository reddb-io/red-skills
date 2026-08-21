import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareVendoredProvenance,
  decodeVendoredProvenance,
  describeToolchainMoves,
  encodeVendoredProvenance,
  formatVendoredVerdict,
  hashBytes,
  hashSourceTree,
  sortSources,
  VENDORED_PROVENANCE_PATH,
  VENDORED_REFRESH_COMMAND,
  type VendoredObservation,
  type VendoredProvenance,
} from "../src/vendored-provenance.js";
import { VENDORED_RELEASE_BUNDLE_PATH } from "../src/workflow-generator.js";

const RELEASE_ROOT = resolve(import.meta.dirname, "..");
const REPO_ROOT = resolve(RELEASE_ROOT, "..", "..");
const VENDORED = join(REPO_ROOT, VENDORED_RELEASE_BUNDLE_PATH);

const scratchRoots: string[] = [];

afterEach(() => {
  for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * The vendored engine is a BUILD ARTIFACT committed into the tree, and a build
 * artifact nothing rebuilds is a copy of whatever the source used to say.
 *
 * `release.execution: vendored` makes the release workflow run this file rather
 * than a published npm version, which is what lets a release fix apply without
 * first being published. That inverts into its own trap: two fixes to the engine
 * landed on main, the workflow ran the frozen bundle, and the release train
 * reproduced both bugs from source that no longer contained them (#3466).
 *
 * The check used to REBUILD the source and compare bytes. That verdict is not a
 * property of the tree (#4282): esbuild renames minified identifiers according
 * to the exact esbuild build doing the work, so two machines resolving different
 * patches of the catalogued `^0.24.0` produced 44 bytes of `we` ↔ `Ee` on one
 * unchanged commit — red here, green there, and the message blamed the source.
 *
 * So the bundle carries its claim in `release.bundle.provenance.toon`, and this
 * asks whether the tree still matches the claim. It costs a few file reads and
 * no build at all.
 */
describe("vendored release engine (#3466, #4282)", () => {
  it("matches the source recorded beside it", () => {
    const recorded = readRecordedProvenance();
    const verdict = compareVendoredProvenance(recorded, observeTree(recorded, REPO_ROOT));

    // Said out loud rather than swallowed: this machine may minify differently
    // than the one that vendored the bundle, and the next reader who diffs the
    // bytes should already know that is why they differ.
    const toolchainNote = describeToolchainMoves(verdict);
    if (toolchainNote) console.info(toolchainNote);

    expect(verdict.inSync, formatVendoredVerdict(verdict)).toBe(true);
  });

  it("records the closure esbuild actually consumed, not a directory walk", () => {
    const recorded = readRecordedProvenance();

    // The entry must be there, and so must the workspace source the bundle
    // inlines — a record that stopped at `apps/release/src` would go green while
    // a fix in `packages/shared` sat unvendored, which is #3466 wearing a hat.
    expect(recorded.sources.map((source) => source.path)).toContain("apps/release/src/cli.ts");
    expect(recorded.sources.some((source) => source.path.startsWith("packages/"))).toBe(true);
    expect(recorded.sources.some((source) => source.path.includes("node_modules"))).toBe(false);
    expect(recorded.sources.some((source) => source.path.endsWith(".test.ts"))).toBe(false);
    expect(recorded.refreshCommand).toBe(VENDORED_REFRESH_COMMAND);
    expect(recorded.bundle).toBe(VENDORED_RELEASE_BUNDLE_PATH);
    expect(recorded.sourceTreeSha256).toBe(hashSourceTree(recorded.sources));
  });

  /**
   * The negatives run against a FABRICATED tree, never the checkout.
   *
   * Proving "an edit reds it" by editing the real source would make these tests
   * restate the live check: one genuine drift would red four tests with four
   * messages, and the reader would have to work out which one was the finding.
   */
  it("fails naming the file when a recorded source is edited", () => {
    const { root, provenance } = fabricateVendoredTree();
    const target = "apps/release/src/release-engine.ts";
    writeFileSync(join(root, target), "// an engine fix that never reached the vendored bundle\n", "utf8");

    const verdict = compareVendoredProvenance(provenance, observeTree(provenance, root));
    const message = formatVendoredVerdict(verdict);

    expect(verdict.inSync).toBe(false);
    expect(verdict.sourceDrift.map((change) => change.path)).toEqual([target]);
    expect(message).toContain(target);
    expect(message).toContain(VENDORED_REFRESH_COMMAND);
    // The other recorded files did not move, and a message that listed all of
    // them would bury the one that did.
    expect(message).not.toContain("packages/shared/args.ts");
  });

  it("names a recorded source that disappeared", () => {
    const { root, provenance } = fabricateVendoredTree();
    rmSync(join(root, "packages/shared/args.ts"));

    const verdict = compareVendoredProvenance(provenance, observeTree(provenance, root));

    expect(verdict.inSync).toBe(false);
    expect(formatVendoredVerdict(verdict)).toContain("packages/shared/args.ts — recorded, now missing");
  });

  it("does not call a toolchain-only difference source drift", () => {
    // The exact #4282 shape: one unchanged tree, a machine whose esbuild
    // resolves to a different patch of the catalogued range.
    const { root, provenance } = fabricateVendoredTree();
    const observed = observeTree(provenance, root);

    const verdict = compareVendoredProvenance(provenance, {
      ...observed,
      toolchain: { esbuild: "0.24.0", node: "v20.19.0" },
    });

    expect(verdict.inSync).toBe(true);
    expect(verdict.sourceDrift).toEqual([]);
    expect(formatVendoredVerdict(verdict)).toBe("");

    // It is not silent either — it says what actually moved, and never that the
    // source did.
    const note = describeToolchainMoves(verdict);
    expect(note).toContain("esbuild 0.24.2 → 0.24.0");
    expect(note).toContain("node");
    expect(note).not.toMatch(/source (moved|drift)/i);
    expect(describeToolchainMoves({ ...verdict, toolchainMoves: [] })).toBe("");
  });

  it("notices a hand-edited bundle without blaming the source", () => {
    const { root, provenance } = fabricateVendoredTree();
    writeFileSync(join(root, provenance.bundle), "// hand-patched in place\n", "utf8");

    const verdict = compareVendoredProvenance(provenance, observeTree(provenance, root));
    const message = formatVendoredVerdict(verdict);

    expect(verdict.inSync).toBe(false);
    expect(verdict.sourceDrift).toEqual([]);
    expect(message).toContain("is not the bundle");
    expect(message).not.toContain("source moved");
  });

  it("round-trips the record through TOON and refuses a shape it cannot judge", () => {
    const provenance: VendoredProvenance = {
      bundle: VENDORED_RELEASE_BUNDLE_PATH,
      bundleSha256: "a".repeat(64),
      bundleBytes: 12,
      sourceTreeSha256: hashSourceTree([{ path: "b.ts", sha256: "22" }, { path: "a.ts", sha256: "11" }]),
      refreshCommand: VENDORED_REFRESH_COMMAND,
      toolchain: { esbuild: "0.24.2", node: "v22.14.0" },
      sources: sortSources([{ path: "b.ts", sha256: "22" }, { path: "a.ts", sha256: "11" }]),
    };
    const encoded = encodeVendoredProvenance(provenance);

    // TOON, not JSON: the repo's default for a committed structured file.
    expect(encoded.startsWith("{")).toBe(false);
    expect(encoded).toContain("sources[2]{path,sha256}:");
    expect(decodeVendoredProvenance(encoded)).toEqual(provenance);

    // Each refusal names the half it could not read, because a guard that cannot
    // read its own record has to say which half is unreadable.
    expect(() => decodeVendoredProvenance("null")).toThrow(/not a TOON record/);
    expect(() => decodeVendoredProvenance("bundle: x\n")).toThrow(/no toolchain block/);
    expect(() => decodeVendoredProvenance("toolchain:\n  esbuild: 0.24.2\n  node: v22\n")).toThrow(
      /no sources table/,
    );
  });

  it("answers --version without a working machine, as every shipped binary must", () => {
    const answer = execFileSync(process.execPath, [VENDORED, "--version"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(answer.trim().split(/\s+/)[0]).toBe("red-skills-release");
  });
});

function readRecordedProvenance(): VendoredProvenance {
  const path = join(REPO_ROOT, VENDORED_PROVENANCE_PATH);
  if (!existsSync(path)) {
    throw new Error(
      `${VENDORED_PROVENANCE_PATH} is missing — the vendored bundle makes no checkable claim.\n` +
        `Write it with:\n  ${VENDORED_REFRESH_COMMAND}`,
    );
  }
  return decodeVendoredProvenance(readFileSync(path, "utf8"));
}

/** A throwaway in-sync bundle-plus-record pair, to break one way at a time. */
function fabricateVendoredTree(): { root: string; provenance: VendoredProvenance } {
  const root = mkdtempSync(join(tmpdir(), "red-vendor-drift-"));
  scratchRoots.push(root);

  const files: Record<string, string> = {
    "apps/release/src/cli.ts": "export const entry = 1;\n",
    "apps/release/src/release-engine.ts": "export const engine = 2;\n",
    "packages/shared/args.ts": "export const args = 3;\n",
  };
  for (const [path, contents] of Object.entries(files)) write(root, path, contents);
  write(root, VENDORED_RELEASE_BUNDLE_PATH, "// pretend bundle\n");

  const sources = sortSources(
    Object.keys(files).map((path) => ({ path, sha256: hashBytes(readFileSync(join(root, path))) })),
  );
  const bundle = readFileSync(join(root, VENDORED_RELEASE_BUNDLE_PATH));
  return {
    root,
    provenance: {
      bundle: VENDORED_RELEASE_BUNDLE_PATH,
      bundleSha256: hashBytes(bundle),
      bundleBytes: bundle.byteLength,
      sourceTreeSha256: hashSourceTree(sources),
      refreshCommand: VENDORED_REFRESH_COMMAND,
      toolchain: { esbuild: "0.24.2", node: "v22.14.0" },
      sources,
    },
  };
}

function write(root: string, path: string, contents: string): void {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, contents, "utf8");
}

/** Exactly what the guard measures: the recorded paths, rehashed, no build. */
function observeTree(recorded: VendoredProvenance, root: string): VendoredObservation {
  const sourceHashes = new Map<string, string | undefined>();
  for (const source of recorded.sources) {
    const path = join(root, source.path);
    sourceHashes.set(source.path, existsSync(path) ? hashBytes(readFileSync(path)) : undefined);
  }
  const bundle = readFileSync(join(root, recorded.bundle));
  return {
    bundleSha256: hashBytes(bundle),
    bundleBytes: bundle.byteLength,
    sourceHashes,
    toolchain: { esbuild: localEsbuildVersion(), node: process.version },
  };
}

/**
 * The esbuild this machine would minify with.
 *
 * Read off the resolved package rather than by spawning the binary: the guard's
 * whole point is that it costs no build, and the answer is only ever used to
 * EXPLAIN a difference, never to fail on one.
 */
function localEsbuildVersion(): string {
  const require = createRequire(import.meta.url);
  try {
    return String((require("esbuild") as { version?: string }).version ?? "unknown");
  } catch {
    return "unknown";
  }
}
