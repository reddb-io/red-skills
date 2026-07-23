#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
const pluginDir = process.argv[2] ? join(process.cwd(), process.argv[2]) : "";
const rootDir = process.argv[3] ? join(process.cwd(), process.argv[3]) : repoRoot;
const errors = [];

if (!pluginDir) {
  console.error("usage: node scripts/plugin-structural-smoke.mjs <plugin-dir> [repo-root]");
  process.exit(2);
}

const plugin = basename(pluginDir);

function fail(message) {
  errors.push(`${plugin}: ${message}`);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${relative(rootDir, path)} is not valid JSON: ${error.message}`);
    return {};
  }
}

function walk(dir, predicate, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const st = statSync(path);
    if (st.isDirectory()) {
      if (entry !== "node_modules") walk(path, predicate, out);
    } else if (predicate(path)) {
      out.push(path);
    }
  }
  return out;
}

function normalizeSkillPath(path) {
  return path.replace(/\/+$/, "");
}

function listedClaudeSkills(manifest) {
  if (!Array.isArray(manifest.skills)) {
    fail("Claude plugin manifest skills must be an array");
    return [];
  }
  return manifest.skills.map(normalizeSkillPath).sort();
}

function publishedSkills() {
  return walk(join(pluginDir, "skills"), (path) => basename(path) === "SKILL.md")
    .filter((path) => !path.includes("/deprecated/") && !path.includes("/in-progress/"))
    .map((path) => `./${relative(pluginDir, dirname(path))}`)
    .map(normalizeSkillPath)
    .sort();
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateRelativePath(manifest, key, owner) {
  if (manifest[key] === undefined) return;
  if (typeof manifest[key] !== "string" || !manifest[key].startsWith("./")) {
    fail(`${owner} ${key} must be a relative ./ path`);
    return;
  }
  const target = join(pluginDir, manifest[key].slice(2));
  if (!existsSync(target)) fail(`${owner} ${key} target is missing: ${manifest[key]}`);
}

function validateCodexSkills(codex, skills) {
  if (codex.skills === "./skills/") return;
  if (!Array.isArray(codex.skills) || codex.skills.length === 0) {
    fail("Codex plugin manifest skills must be ./skills/ or a non-empty array");
    return;
  }
  const buckets = codex.skills.map((path) => path.replace(/\/+$/, "/"));
  for (const bucket of buckets) {
    if (!bucket.startsWith("./skills/") || !bucket.endsWith("/")) {
      fail(`Codex skills bucket must be a ./skills/<bucket>/ path: ${bucket}`);
      continue;
    }
    if (!existsSync(join(pluginDir, bucket.slice(2)))) {
      fail(`Codex skills bucket is missing on disk: ${bucket}`);
    }
  }
  for (const skill of skills) {
    if (!buckets.some((bucket) => `${skill}/`.startsWith(bucket))) {
      fail(`Codex skills buckets do not expose published skill ${skill}`);
    }
  }
}

function validateNoWildcardToolGrants() {
  const files = [
    join(pluginDir, ".claude-plugin", "plugin.json"),
    join(pluginDir, ".codex-plugin", "plugin.json"),
    ...walk(pluginDir, (path) => /\.(json|md|ya?ml)$/.test(path)),
  ];
  const seen = new Set();
  for (const file of files) {
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    const rel = relative(rootDir, file);
    if (/^\s*(tools|allowed-tools)\s*:\s*["']?\*["']?\s*$/m.test(text)) {
      fail(`wildcard tool grant in ${rel}`);
    }
    if (/"(?:tools|allowed-tools)"\s*:\s*(?:"\*"|\[[^\]]*"[\w:-]*\*[\w:-]*")/s.test(text)) {
      fail(`wildcard tool grant in ${rel}`);
    }
  }
}

const claudePath = join(pluginDir, ".claude-plugin", "plugin.json");
const codexPath = join(pluginDir, ".codex-plugin", "plugin.json");
const geminiPath = join(pluginDir, ".gemini-plugin", "plugin.json");
if (!existsSync(claudePath)) fail("missing .claude-plugin/plugin.json");
if (!existsSync(codexPath)) fail("missing .codex-plugin/plugin.json");
if (!existsSync(geminiPath)) fail("missing .gemini-plugin/plugin.json");

const claude = existsSync(claudePath) ? readJson(claudePath) : {};
const codex = existsSync(codexPath) ? readJson(codexPath) : {};

if (claude.name !== plugin) fail(`Claude plugin name must be ${plugin}`);
if (codex.name !== plugin) fail(`Codex plugin name must be ${plugin}`);
if (!claude.version || claude.version !== codex.version) {
  fail("Claude and Codex plugin versions must match and be non-empty");
}

for (const [manifest, owner] of [[claude, "Claude"], [codex, "Codex"]]) {
  for (const key of ["mcpServers", "hooks"]) validateRelativePath(manifest, key, owner);
}

const skills = publishedSkills();
if (!arraysEqual(skills, listedClaudeSkills(claude))) {
  fail("Claude plugin skill list is out of sync with SKILL.md files on disk");
}
validateCodexSkills(codex, skills);

const readmePath = join(rootDir, "README.md");
if (!existsSync(readmePath)) {
  fail("root README.md is missing");
} else {
  const readme = readFileSync(readmePath, "utf8");
  if (!readme.includes(`./plugins/${plugin}/`)) {
    fail("root README must list shipped plugin with a ./plugins/<plugin>/ link");
  }
}

validateNoWildcardToolGrants();

if (errors.length > 0) {
  for (const error of errors) console.error(`error: ${error}`);
  process.exit(1);
}

console.log(`${plugin} plugin structural smoke ok`);
