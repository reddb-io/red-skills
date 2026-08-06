#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
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

function parseYamlScalar(value, field, relativePath) {
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      throw new Error(`${relativePath}: ${field} is not a valid quoted scalar`);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

/** Parse the three SKILL.md frontmatter fields projected into Codex's sidecar. */
export function parseCodexSkillFrontmatter(source, relativePath = "SKILL.md") {
  const lines = source.split(/\r?\n/);
  if (lines[0] !== "---") throw new Error(`${relativePath}: missing YAML frontmatter`);
  const end = lines.indexOf("---", 1);
  if (end === -1) throw new Error(`${relativePath}: unterminated YAML frontmatter`);

  const values = new Map();
  for (let index = 1; index < end; index += 1) {
    const match = /^([a-z][a-z0-9-]*):(?:\s*(.*))?$/.exec(lines[index]);
    if (!match) continue;
    const [, key, rawValue = ""] = match;
    if (rawValue === ">-" || rawValue === ">" || rawValue === "|-" || rawValue === "|") {
      const continuation = [];
      while (index + 1 < end && /^(?:\s+|$)/.test(lines[index + 1])) {
        index += 1;
        continuation.push(lines[index].trim());
      }
      values.set(key, continuation.join(rawValue.startsWith(">") ? " " : "\n").trim());
      continue;
    }
    values.set(key, parseYamlScalar(rawValue.trim(), key, relativePath));
  }

  const name = values.get("name");
  const description = values.get("description");
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error(`${relativePath}: frontmatter has no name`);
  }
  if (typeof description !== "string" || description.trim() === "") {
    throw new Error(`${relativePath}: frontmatter has no description`);
  }
  return {
    name,
    description,
    disableModelInvocation: values.get("disable-model-invocation") === "true",
  };
}

/** Codex accepts JSON string scalars in YAML, keeping escaping dependency-free. */
export function buildCodexSkillSidecar(frontmatter) {
  const lines = [
    "interface:",
    `  display_name: ${JSON.stringify(titleCaseName(frontmatter.name))}`,
    `  short_description: ${JSON.stringify(normalizeText(frontmatter.description))}`,
  ];
  if (frontmatter.disableModelInvocation) {
    lines.push("policy:", "  allow_implicit_invocation: false");
  }
  return `${lines.join("\n")}\n`;
}

async function walkSkillFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }

  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkSkillFiles(path));
    else if (entry.isFile() && entry.name === "SKILL.md") files.push(path);
  }
  return files;
}

/** Derive the sidecar obligation from every plugin's skills tree, never a hand-kept list. */
export async function discoverCodexSkillFiles(root) {
  const pluginsRoot = join(root, "plugins");
  let plugins;
  try {
    plugins = await readdir(pluginsRoot, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }

  const files = [];
  for (const plugin of plugins.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!plugin.isDirectory()) continue;
    files.push(...await walkSkillFiles(join(pluginsRoot, plugin.name, "skills")));
  }
  return files;
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

  for (const skillPath of await discoverCodexSkillFiles(root)) {
    const relativePath = relative(root, skillPath).replaceAll("\\", "/");
    const frontmatter = parseCodexSkillFrontmatter(await readFile(skillPath, "utf8"), relativePath);
    await writeGenerated(
      join(dirname(skillPath), "agents/openai.yaml"),
      buildCodexSkillSidecar(frontmatter),
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
