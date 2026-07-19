#!/usr/bin/env node
// scripts/build-pi-packages.mjs — stage per-plugin Pi packages for npm publish.
//
// Mirrors packaging/npm/scripts/prepare.mjs (the runtime bundle) for the Pi
// surface (skills only). Reads the canonical Claude-side plugin tree under
// plugins/<name>/, regenerates the per-plugin package.json from
// generate-pi-manifests.mjs's `buildPiPackage`, then copies the published
// skill buckets (everything under skills/<bucket>/ except in-progress/ and
// deprecated/) into packaging/pi/<name>/skills/<bucket>/.
//
// The staging output under packaging/pi/ is what `red-release.yml` publishes
// to npm. The generator-driven plugins/<name>/package.json from #2167 stays
// the canonical "path-based install" surface; this script feeds the parallel
// "npm: install" surface (ADR 0110).
//
// Usage:
//   node scripts/build-pi-packages.mjs --root .
//   node scripts/build-pi-packages.mjs --root . --check   # fail on drift
//
// Exit codes: 0 success; 1 drift detected; 2 usage error.

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildPiPackage } from "./generate-pi-manifests.mjs";

const PUBLISHED_BUCKETS = ["engineering", "knowledge", "productivity", "misc", "core", "maintainer"];
const SKIP_BUCKETS = new Set(["in-progress", "deprecated"]);
const NPM_SCOPE = "@reddb-io";
const PACKAGING_ROOT = "packaging/pi";

function parseArgs(argv) {
  const args = { root: process.cwd(), check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      args.check = true;
      continue;
    }
    if (arg === "--root") {
      const next = argv[index + 1];
      if (!next) throw new Error("--root requires a path");
      args.root = next;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function jsonBytes(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isPublishedBucket(name) {
  return PUBLISHED_BUCKETS.includes(name);
}

function deriveBucketList(pluginSkills) {
  // pluginSkills is the array from .claude-plugin/plugin.json like
  // ["./skills/engineering/afk", "./skills/core/wiki"]. We collapse to the
  // distinct bucket directories that have at least one SKILL.md on disk.
  const out = new Set();
  for (const entry of pluginSkills ?? []) {
    const m = String(entry).match(/^\.\/skills\/([^/]+)/);
    if (m) out.add(m[1]);
  }
  return [...out].filter(isPublishedBucket);
}

function buildNpmPackageJson(claudePlugin) {
  // Identical to buildPiPackage's shape except:
  // - drop the local-only "private": true so npm accepts the publish
  // - add publishConfig.access=public so scoped @reddb-io/* publishes publicly
  // - tighten files to just skills + package.json (no source tree leakage)
  const base = buildPiPackage(claudePlugin);
  const { private: _private, ...publishable } = base;
  return {
    ...publishable,
    publishConfig: { access: "public" },
    files: ["skills/**/*", "package.json", "README.md"],
  };
}

async function stagePackage({ root, plugin, claudePlugin, packagingDir, mismatches, check }) {
  const pluginName = claudePlugin.name;
  const pluginRoot = join(root, plugin.source);
  // packagingDir is already root-joined by buildPiPackages (e.g.
  // <root>/packaging/pi). Appending the plugin name here avoids the
  // double-join that would otherwise turn absolute paths into
  // <root><root>/packaging/pi/<name>.
  const targetDir = join(packagingDir, pluginName);

  const packageJson = buildNpmPackageJson(claudePlugin);
  const buckets = deriveBucketList(claudePlugin.skills);

  if (buckets.length === 0) {
    throw new Error(`${pluginName}: no published skill buckets to stage`);
  }

  // 1. Stage package.json
  await writeOrCheck(
    join(targetDir, "package.json"),
    jsonBytes(packageJson),
    check,
    mismatches,
  );

  // 2. Stage skills/<bucket>/ for each published bucket
  for (const bucket of buckets) {
    const sourceBucket = join(pluginRoot, "skills", bucket);
    const targetBucket = join(targetDir, "skills", bucket);
    if (check) {
      // Verify the staged tree byte-for-byte matches what staging would produce.
      const tempTarget = await mkdtemp(join(tmpdir(), "red-skills-pi-check-"));
      try {
        const tempBucket = join(tempTarget, bucket);
        await cp(sourceBucket, tempBucket, {
          recursive: true,
          filter: (src) => !SKIP_BUCKETS.has(src.split("/").pop() ?? ""),
        });
        const drift = await diffDirs(tempBucket, targetBucket);
        if (drift.length > 0) {
          mismatches.push({ path: targetBucket, bytes: "", note: drift });
        }
      } finally {
        await rm(tempTarget, { recursive: true, force: true });
      }
    } else {
      await rm(targetBucket, { recursive: true, force: true });
      await mkdir(targetBucket, { recursive: true });
      await cp(sourceBucket, targetBucket, {
        recursive: true,
        filter: (src) => {
          const base = src.split("/").pop() ?? "";
          return !SKIP_BUCKETS.has(base);
        },
      });
    }
  }

  // 3. Stage a small README so `npm view` shows project context, not just an
  // auto-generated "no description" stub.
  await writeOrCheck(
    join(targetDir, "README.md"),
    renderPackageReadme({ pluginName, packageJson, buckets }),
    check,
    mismatches,
  );
}

function renderPackageReadme({ pluginName, packageJson, buckets }) {
  const bucketList = buckets.map((b) => `- \`skills/${b}/\``).join("\n");
  return `# ${packageJson.name}

${packageJson.description}

This package ships the **${pluginName}** plugin's skill tree for [pi](https://pi.dev) (the \`@earendil-works/pi-coding-agent\` harness). It carries the same \`SKILL.md\` files the Claude Code and Codex marketplaces already expose, scoped to the published buckets only:

${bucketList}

Install:

\`\`\`bash
pi install npm:${packageJson.name}
\`\`\`

Updates follow the same release train as the rest of the red-skills monorepo. \`pi update --all\` resolves the latest matching version from the npm registry.

## Source

This package is generated from \`plugins/${pluginName}/\` in [reddb-io/red-skills](https://github.com/reddb-io/red-skills). To regenerate locally:

\`\`\`bash
pnpm pi:packages:build
\`\`\`

## License

Apache-2.0.
`;
}

async function writeOrCheck(path, bytes, check, mismatches) {
  if (!check) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    return;
  }
  let current = "";
  try {
    current = await readFile(path, "utf8");
  } catch {
    current = "";
  }
  if (current !== bytes) {
    mismatches.push({ path, bytes });
  }
}

async function diffDirs(leftDir, rightDir) {
  // Walk both trees in parallel and report any byte differences or missing
  // files. Returns an array of human-readable drift notes (empty = in sync).
  const drift = [];
  async function walk(dir, prefix, out) {
    const entries = await (await import("node:fs/promises")).readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), rel, out);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  }
  const left = [];
  const right = [];
  await walk(leftDir, "", left);
  await walk(rightDir, "", right);
  const allKeys = new Set([...left, ...right]);
  for (const key of allKeys) {
    if (!left.includes(key)) {
      drift.push(`${key}: missing in source`);
      continue;
    }
    if (!right.includes(key)) {
      drift.push(`${key}: missing in staged`);
      continue;
    }
    const a = await readFile(join(leftDir, key));
    const b = await readFile(join(rightDir, key));
    if (!a.equals(b)) {
      drift.push(`${key}: bytes differ`);
    }
  }
  return drift;
}

async function printDiffs(root, mismatches) {
  const tempRoot = await mkdtemp(join(tmpdir(), "red-skills-pi-pkg-diff-"));
  try {
    for (const mismatch of mismatches) {
      if (mismatch.note) {
        console.error(`# ${relative(root, mismatch.path)}\n${mismatch.note.join("\n")}`);
        continue;
      }
      const rel = relative(root, mismatch.path);
      const expected = join(tempRoot, rel);
      await mkdir(dirname(expected), { recursive: true });
      await writeFile(expected, mismatch.bytes);
      const diff = spawnSync("git", ["diff", "--no-index", "--", mismatch.path, expected], {
        encoding: "utf8",
      });
      const output = `${diff.stdout}${diff.stderr}`.trim();
      if (output) console.error(output);
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export async function buildPiPackages({ root, check = false }) {
  const mismatches = [];
  const claudeMarketplacePath = join(root, ".claude-plugin/marketplace.json");
  const claudeMarketplace = await readJson(claudeMarketplacePath);
  const packagingDir = join(root, PACKAGING_ROOT);

  for (const plugin of claudeMarketplace.plugins) {
    const pluginRoot = join(root, plugin.source);
    const claudePlugin = await readJson(join(pluginRoot, ".claude-plugin/plugin.json"));
    await stagePackage({ root, plugin, claudePlugin, packagingDir, mismatches, check });
  }

  if (check && mismatches.length > 0) {
    await printDiffs(root, mismatches);
    throw new Error(
      `Pi packages are stale; run pnpm pi:packages:build (${mismatches.length} mismatched file(s) or dir(s))`,
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await buildPiPackages(args);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}