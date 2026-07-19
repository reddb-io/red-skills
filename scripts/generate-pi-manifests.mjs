#!/usr/bin/env node
// Generates Pi-package manifests for every RedSkills plugin from the canonical
// Claude-side plugin tree, mirroring scripts/generate-codex-manifests.mjs.
//
// Pi packages are installed via `pi install <local-path>` and need a
// package.json with a `pi-package` keyword plus a `pi.skills` array pointing at
// the same skill buckets the Claude/Codex manifests expose. This script keeps
// the per-plugin package.json files under `plugins/<name>/package.json` in
// sync with the source-of-truth Claude manifests; run `pnpm pi:manifests` to
// regenerate, `pnpm pi:manifests:check` to fail on drift.
//
// The generated package.json intentionally lives alongside the existing
// .claude-plugin/plugin.json and .codex-plugin/plugin.json so a single source
// tree continues to serve every host without forking the plugin definitions.
// Skills exposed here are the same bucket paths the Codex manifest lists, so
// a `pi install ./plugins/dev` install gives the agent every published dev
// skill (engineering/knowledge/productivity/misc) without the in-progress
// drafts.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_URL = "https://github.com/reddb-io/red-skills";
const HOMEPAGE = "https://github.com/reddb-io/red-skills";
const LICENSE = "Apache-2.0";
const PREFERRED_SKILL_ROOT_ORDER = ["engineering", "knowledge", "productivity", "misc", "core"];
const SCOPED_NAMESPACE = "@reddb-io";

function parseArgs(argv) {
  const args = {
    root: process.cwd(),
    check: false,
  };

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

function titleCaseName(name) {
  return String(name)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function normalizeSkillEntry(entry) {
  return String(entry).replace(/\/+$/, "");
}

function deriveSkillRoots(skills) {
  if (typeof skills === "string") {
    return skills.startsWith("./skills/") || skills === "./skills/" ? skills : `./skills/${skills.replace(/^\.\//, "")}/`;
  }
  if (!Array.isArray(skills)) return [];

  const roots = new Set();
  for (const skill of skills) {
    const normalized = normalizeSkillEntry(skill);
    const match = normalized.match(/^\.\/skills\/([^/]+)/);
    if (match) roots.add(match[1]);
  }

  const orderedRoots = [...roots].sort((left, right) => {
    const leftIndex = PREFERRED_SKILL_ROOT_ORDER.indexOf(left);
    const rightIndex = PREFERRED_SKILL_ROOT_ORDER.indexOf(right);
    if (leftIndex !== -1 || rightIndex !== -1) {
      return (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex) -
        (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex);
    }
    return left.localeCompare(right);
  });

  // The Pi package manifest sits at plugins/<name>/package.json, so paths are
  // rooted there and must include the shared `./skills/` prefix the Claude and
  // Codex manifests also use. Pi auto-discovers SKILL.md files recursively
  // beneath each listed directory.
  return orderedRoots.map((root) => `./skills/${root}/`);
}

function descriptionText(input) {
  return String(input ?? "")
    .replace(/[`\u2018\u2019]/g, "")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildPiPackage(claudePlugin) {
  const description = descriptionText(claudePlugin.description);
  const packageName = `${SCOPED_NAMESPACE}/red-skills-${claudePlugin.name}`;
  const skillRoots = deriveSkillRoots(claudePlugin.skills);
  if (skillRoots.length === 0) {
    throw new Error(
      `${claudePlugin.name}: cannot derive skill buckets from Claude plugin manifest`,
    );
  }

  const packageJson = {
    name: packageName,
    version: claudePlugin.version,
    private: true,
    description,
    license: LICENSE,
    homepage: HOMEPAGE,
    repository: {
      type: "git",
      url: `${REPO_URL}.git`,
    },
    keywords: ["pi-package", "reddb-io", "red-skills", ...(claudePlugin.dependencies ?? []).map((dep) => `dep:${dep}`)],
    pi: {
      skills: skillRoots,
    },
  };

  return packageJson;
}

function jsonBytes(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeGenerated(path, bytes, check, mismatches) {
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

async function printDiffs(root, mismatches) {
  const tempRoot = await mkdtemp(join(tmpdir(), "red-skills-pi-manifest-diff-"));
  try {
    for (const mismatch of mismatches) {
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

export async function generatePiManifests({ root, check = false }) {
  const mismatches = [];
  const claudeMarketplacePath = join(root, ".claude-plugin/marketplace.json");
  const claudeMarketplace = await readJson(claudeMarketplacePath);

  for (const plugin of claudeMarketplace.plugins) {
    const pluginRoot = join(root, plugin.source);
    const claudePlugin = await readJson(join(pluginRoot, ".claude-plugin/plugin.json"));
    const packageJson = buildPiPackage(claudePlugin);
    await writeGenerated(
      join(pluginRoot, "package.json"),
      jsonBytes(packageJson),
      check,
      mismatches,
    );
  }

  if (check && mismatches.length > 0) {
    await printDiffs(root, mismatches);
    throw new Error(
      `Pi manifests are stale; run node scripts/generate-pi-manifests.mjs (${mismatches.length} file(s))`,
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await generatePiManifests(args);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}