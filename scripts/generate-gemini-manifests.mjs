#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_URL = "https://github.com/reddb-io/red-skills";
const AUTHOR = {
  name: "reddb.io",
  url: "https://github.com/reddb-io",
};
const CAPABILITIES = ["Interactive", "Read", "Write", "Shell"];
const PREFERRED_SKILL_ROOT_ORDER = ["engineering", "knowledge", "productivity", "misc", "core"];

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

function geminiText(input) {
  return String(input ?? "")
    .replace(/[`\u2018\u2019]/g, "")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\s+/g, " ")
    .trim();
}

function titleCaseName(name) {
  return String(name)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function marketplaceDisplayName(name) {
  if (name === "red-skills") return "RedSkills";
  return titleCaseName(name);
}

function brandColorForPlugin(name) {
  if (name === "brain") return "#2563EB";
  return "#D92D20";
}

function pluginKeywords(name) {
  const keywords = ["gemini-cli", "skills", "agents"];
  if (name === "dev") return [...keywords, "github-issues", "tdd"];
  return [...keywords, name];
}

function normalizeSkillEntry(entry) {
  return String(entry).replace(/\/+$/, "");
}

function deriveGeminiSkillRoots(skills) {
  if (typeof skills === "string") {
    return skills.endsWith("/") ? skills : `${skills}/`;
  }
  if (!Array.isArray(skills)) return undefined;

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
      return (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex) - (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex);
    }
    return left.localeCompare(right);
  });

  return orderedRoots.map((root) => `./skills/${root}/`);
}

function defaultPromptForPlugin(name, skills) {
  const skillEntries = Array.isArray(skills) ? skills : [];
  const skillNames = skillEntries
    .map((entry) => normalizeSkillEntry(entry).split("/").at(-1))
    .filter(Boolean)
    .slice(0, 4);

  if (skillNames.length === 0) return [`Use RedSkills ${titleCaseName(name)} when this workspace needs it.`];
  return skillNames.map((skill) => `Use $${skill} when this workspace needs it.`);
}

function maybeSet(target, key, value) {
  if (value !== undefined) target[key] = value;
}

export function buildGeminiMarketplace(claudeMarketplace) {
  return {
    name: claudeMarketplace.name,
    interface: {
      displayName: marketplaceDisplayName(claudeMarketplace.name),
    },
    plugins: claudeMarketplace.plugins.map((plugin) => {
      const geminiPlugin = {
        name: plugin.name,
        source: {
          source: "local",
          path: plugin.source,
        },
        policy: {
          installation: plugin.name === "dev" ? "INSTALLED_BY_DEFAULT" : "AVAILABLE",
          authentication: "ON_USE",
        },
      };
      maybeSet(geminiPlugin, "dependencies", plugin.dependencies);
      maybeSet(geminiPlugin, "description", geminiText(plugin.description));
      geminiPlugin.category = "Developer Tools";
      return geminiPlugin;
    }),
  };
}

export function buildGeminiPluginManifest(claudePlugin) {
  const description = geminiText(claudePlugin.description);
  const manifest = {
    name: claudePlugin.name,
    version: claudePlugin.version,
    description,
    author: AUTHOR,
    homepage: REPO_URL,
    repository: REPO_URL,
    license: "Apache-2.0",
  };

  maybeSet(manifest, "dependencies", claudePlugin.dependencies);
  manifest.keywords = pluginKeywords(claudePlugin.name);
  maybeSet(manifest, "skills", deriveGeminiSkillRoots(claudePlugin.skills));
  // Gemini CLI hooks are not Claude hook manifests with a renamed file. The
  // native dev extension builder emits the supported hooks/hooks.json subset;
  // this compatibility metadata must not advertise a fabricated sidecar.
  maybeSet(manifest, "mcpServers", claudePlugin.mcpServers);
  manifest.interface = {
    displayName: `RedSkills ${titleCaseName(claudePlugin.name)}`,
    shortDescription: description,
    longDescription: description,
    developerName: AUTHOR.name,
    category: "Developer Tools",
    capabilities: CAPABILITIES,
    websiteURL: REPO_URL,
    defaultPrompt: defaultPromptForPlugin(claudePlugin.name, claudePlugin.skills),
    brandColor: brandColorForPlugin(claudePlugin.name),
  };

  return manifest;
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
  const tempRoot = await mkdtemp(join(tmpdir(), "red-skills-gemini-manifest-diff-"));
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

export async function generateGeminiManifests({ root, check = false }) {
  const mismatches = [];
  const claudeMarketplacePath = join(root, ".claude-plugin/marketplace.json");
  const geminiMarketplacePath = join(root, ".gemini-plugin/marketplace.json");
  const claudeMarketplace = await readJson(claudeMarketplacePath);
  await writeGenerated(geminiMarketplacePath, jsonBytes(buildGeminiMarketplace(claudeMarketplace)), check, mismatches);

  for (const plugin of claudeMarketplace.plugins) {
    const pluginRoot = join(root, plugin.source);
    const claudePlugin = await readJson(join(pluginRoot, ".claude-plugin/plugin.json"));
    await writeGenerated(
      join(pluginRoot, ".gemini-plugin/plugin.json"),
      jsonBytes(buildGeminiPluginManifest(claudePlugin)),
      check,
      mismatches,
    );
  }

  if (check && mismatches.length > 0) {
    await printDiffs(root, mismatches);
    throw new Error(`Gemini manifests are stale; run node scripts/generate-gemini-manifests.mjs (${mismatches.length} file(s))`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await generateGeminiManifests(args);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
