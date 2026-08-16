#!/usr/bin/env node
/**
 * prepare.mjs — stage the built plugin bundles into this npm package's `dist/`
 * before `pnpm pack` / publish (ADR 0091). Copies the platform-independent JS
 * bundles from the repo-root `dist/` (produced by `pnpm bundle`) into
 * `packaging/npm/dist/` so they ship inside the tarball.
 *
 * Missing bundles are reported and skipped rather than failing hard, so a
 * partial build (e.g. only the dev bundle) still packs — the pre-publish
 * contract check is the gate that a required bundle actually resolves.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
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
  "scripts/install-opencode.sh",
  "scripts/install-pi.sh",
  "scripts/lib/manifest-core.mjs",
];

// Each entry stages one bundle into this package's dist/. `dest` is the packaged
// filename the bin shims / launchers resolve; the first existing `sources` entry
// is copied to it. Most bundles are named identically by `pnpm bundle`, but
// code-nav's turbo outfile is `code-nav-mcp.bundle.min.mjs` while the packaged /
// release-asset name is `code-nav.bundle.min.mjs` — so it lists both: CI's
// dedicated code-nav step pre-copies the asset name, and the plain `pnpm bundle`
// path falls back to the turbo outfile. No bundle silently skips as "not built".
const BUNDLES = [
  { dest: "opencode-host.bundle.min.mjs", sources: ["opencode-host.bundle.min.mjs"] },
  { dest: "dev.bundle.min.mjs", sources: ["dev.bundle.min.mjs"] },
  { dest: "redskilled-mcp.bundle.min.mjs", sources: ["redskilled-mcp.bundle.min.mjs"] },
  { dest: "code-nav.bundle.min.mjs", sources: ["code-nav.bundle.min.mjs", "code-nav-mcp.bundle.min.mjs"] },
  { dest: "memory.bundle.min.mjs", sources: ["memory.bundle.min.mjs"] },
  { dest: "memory-tokenizer.asset.cjs", sources: ["memory-tokenizer.asset.cjs"] },
  { dest: "brain.bundle.min.mjs", sources: ["brain.bundle.min.mjs"] },
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
