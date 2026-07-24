#!/usr/bin/env node
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  jsonBytes,
  normalizeSkillEntry,
  normalizeText,
  parseArgs,
  printDiffs,
  readJson,
  titleCaseName,
  writeGenerated,
} from "./lib/manifest-core.mjs";

const REPO_URL = "https://github.com/reddb-io/red-skills";
const AUTHOR = {
  name: "reddb.io",
  url: "https://github.com/reddb-io",
};
const CAPABILITIES = ["Interactive", "Read", "Write", "Shell"];
const PREFERRED_SKILL_ROOT_ORDER = ["engineering", "knowledge", "productivity", "misc", "core"];

function marketplaceDisplayName(name) {
  if (name === "red-skills") return "RedSkills";
  return titleCaseName(name);
}

function brandColorForPlugin(name) {
  if (name === "brain") return "#2563EB";
  return "#D92D20";
}

function pluginKeywords(name) {
  const keywords = ["codex", "claude-code", "skills", "agents"];
  if (name === "dev") return [...keywords, "github-issues", "tdd"];
  return [...keywords, name];
}

function deriveCodexSkillRoots(skills) {
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

function codexHooksPath(hooks) {
  if (typeof hooks !== "string") return undefined;
  return hooks.replace(/claude\.hooks\.json$/, "codex.hooks.json");
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

export function buildCodexMarketplace(claudeMarketplace) {
  return {
    name: claudeMarketplace.name,
    interface: {
      displayName: marketplaceDisplayName(claudeMarketplace.name),
    },
    plugins: claudeMarketplace.plugins.map((plugin) => {
      const codexPlugin = {
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
      maybeSet(codexPlugin, "dependencies", plugin.dependencies);
      maybeSet(codexPlugin, "description", normalizeText(plugin.description));
      codexPlugin.category = "Developer Tools";
      return codexPlugin;
    }),
  };
}

export function buildCodexPluginManifest(claudePlugin) {
  const description = normalizeText(claudePlugin.description);
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
  maybeSet(manifest, "skills", deriveCodexSkillRoots(claudePlugin.skills));
  maybeSet(manifest, "hooks", codexHooksPath(claudePlugin.hooks));
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

export async function generateCodexManifests({ root, check = false }) {
  const mismatches = [];
  const claudeMarketplacePath = join(root, ".claude-plugin/marketplace.json");
  const codexMarketplacePath = join(root, ".agents/plugins/marketplace.json");
  const claudeMarketplace = await readJson(claudeMarketplacePath);
  await writeGenerated(codexMarketplacePath, jsonBytes(buildCodexMarketplace(claudeMarketplace)), check, mismatches);

  for (const plugin of claudeMarketplace.plugins) {
    const pluginRoot = join(root, plugin.source);
    const claudePlugin = await readJson(join(pluginRoot, ".claude-plugin/plugin.json"));
    await writeGenerated(
      join(pluginRoot, ".codex-plugin/plugin.json"),
      jsonBytes(buildCodexPluginManifest(claudePlugin)),
      check,
      mismatches,
    );
  }

  if (check && mismatches.length > 0) {
    await printDiffs(root, mismatches, { tempLabel: "red-skills-codex-manifest-diff-" });
    throw new Error(`Codex manifests are stale; run node scripts/generate-codex-manifests.mjs (${mismatches.length} file(s))`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await generateCodexManifests(args);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
