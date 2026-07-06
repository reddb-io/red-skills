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
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const repoRoot = join(pkgRoot, "..", "..");
const srcDist = join(repoRoot, "dist");
const destDist = join(pkgRoot, "dist");

const BUNDLES = ["dev.bundle.min.mjs", "memory.bundle.min.mjs", "brain.bundle.min.mjs"];

mkdirSync(destDist, { recursive: true });
let staged = 0;
for (const name of BUNDLES) {
  const src = join(srcDist, name);
  if (!existsSync(src)) {
    process.stderr.write(`prepare: ${name} not built at ${src}; skipping\n`);
    continue;
  }
  copyFileSync(src, join(destDist, name));
  staged += 1;
  process.stdout.write(`prepare: staged ${name}\n`);
}
if (staged === 0) {
  process.stderr.write("prepare: no bundles staged — run `pnpm bundle` first\n");
  process.exit(1);
}
