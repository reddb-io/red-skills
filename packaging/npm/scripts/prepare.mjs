#!/usr/bin/env node
/**
 * prepare.mjs — stage the built non-plugin bundles into this npm package's
 * `dist/` before `pnpm pack` / publish (ADR 0146). Per-plugin runtime bundles
 * ship from `@reddb-io/red-skills-<plugin>` instead; this core package keeps
 * only the supporting runtimes its retained bin/host surfaces need.
 *
 * Missing bundles are reported and skipped rather than failing hard, so a
 * partial supporting-runtime build can still pack — the pre-publish contract
 * check is the gate that every required core surface actually resolves.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const repoRoot = join(pkgRoot, "..", "..");
const srcDist = join(repoRoot, "dist");
const destDist = join(pkgRoot, "dist");

// Host wiring runs from the installed package tree, not from monorepo source.
// Stage only the public manifests and the generators the installer invokes;
// package.json's explicit files allowlist is the final tarball boundary.
const HOST_WIRING_FILES = [
  ".agents/plugins/marketplace.json",
  ".claude-plugin/marketplace.json",
  ".gemini-plugin/marketplace.json",
  "scripts/generate-codex-manifests.mjs",
  "scripts/generate-gemini-manifests.mjs",
  "scripts/generate-pi-manifests.mjs",
  "scripts/build-gemini-extension.mjs",
  "scripts/validate-gemini-extension.mjs",
  "scripts/install-opencode.sh",
  "scripts/install-pi.sh",
  "scripts/lib/manifest-core.mjs",
];

// Each entry stages one non-plugin bundle into this package's dist/. `dest` is
// the packaged filename a retained bin/host surface resolves; the first existing
// `sources` entry is copied to it. The plugin tree is staged independently by
// scripts/build-pi-packages.mjs and must never be duplicated here.
const BUNDLES = [
  { dest: "opencode-host.bundle.min.mjs", sources: ["opencode-host.bundle.min.mjs"] },
  { dest: "redskilled-mcp.bundle.min.mjs", sources: ["redskilled-mcp.bundle.min.mjs"] },
  { dest: "code-nav.bundle.min.mjs", sources: ["code-nav.bundle.min.mjs", "code-nav-mcp.bundle.min.mjs"] },
  { dest: "release.bundle.min.mjs", sources: ["release.bundle.min.mjs"] },
  { dest: "rsp.bundle.min.mjs", sources: ["rsp.bundle.min.mjs"] },
  { dest: "rsp-core.bundle.min.mjs", sources: ["rsp-core.bundle.min.mjs"] },
  { dest: "redskilled.bundle.min.mjs", sources: ["redskilled.bundle.min.mjs"] },
];

for (const relativePath of HOST_WIRING_FILES) {
  const source = join(repoRoot, relativePath);
  const destination = join(pkgRoot, relativePath);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  chmodSync(destination, statSync(source).mode);
  process.stdout.write(`prepare: staged ${relativePath}\n`);
}

// `prepare` is a producer, not an overlay. A bundle staged by an older checkout
// must not leak back into a later core tarball after the package boundary moves.
rmSync(destDist, { recursive: true, force: true });
mkdirSync(destDist, { recursive: true });
let staged = 0;
for (const { dest, sources } of BUNDLES) {
  const src = sources.map((name) => join(srcDist, name)).find((path) => existsSync(path));
  if (!src) {
    process.stderr.write(`prepare: ${dest} not built (looked for ${sources.join(", ")}); skipping\n`);
    continue;
  }
  copyFileSync(src, join(destDist, dest));
  staged += 1;
  process.stdout.write(`prepare: staged ${dest}\n`);
}
if (staged === 0) {
  process.stderr.write("prepare: no bundles staged — run `pnpm bundle` first\n");
  process.exit(1);
}
