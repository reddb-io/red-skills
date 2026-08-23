#!/usr/bin/env node
// Generates Pi-package manifests for every RedSkills plugin from the canonical
// Claude-side plugin tree, mirroring scripts/generate-codex-manifests.mjs.
//
// Pi packages are installed via `pi install <local-path>` and need a
// package.json with a `pi-package` keyword plus a `pi.skills` array pointing at
// the same skill buckets the Claude/Codex manifests expose. Pi 0.84.2 treats
// every root Markdown file under a declared directory as a skill, so entries
// must name only the actual `SKILL.md` files. This script keeps
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
// drafts or bucket README files being interpreted as skills.

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  jsonBytes,
  normalizeSkillEntry,
  normalizeText,
  parseArgs,
  printDiffs,
  readJson,
  writeGenerated,
} from "./lib/manifest-core.mjs";

const REPO_URL = "https://github.com/reddb-io/red-skills";
const HOMEPAGE = "https://github.com/reddb-io/red-skills";
const LICENSE = "Apache-2.0";
const PREFERRED_SKILL_ROOT_ORDER = ["engineering", "knowledge", "productivity", "misc", "core"];
const SCOPED_NAMESPACE = "@reddb-io";

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
  // Codex manifests also use. Keep the glob one directory above SKILL.md:
  // Pi 0.84.2 scans root Markdown files in a declared directory and reports a
  // bucket README as a malformed skill.
  return orderedRoots.map((root) => `./skills/${root}/*/SKILL.md`);
}

export function buildPiPackage(claudePlugin) {
  const description = normalizeText(claudePlugin.description);
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
    await printDiffs(root, mismatches, { tempLabel: "red-skills-pi-manifest-diff-" });
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
