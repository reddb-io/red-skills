#!/usr/bin/env node

import { cp, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NAMESPACE = "redskills-dev";
const OWNED_STATE = "redskills-dev-owned.txt";
const OWNED_HEADER = "redskills-hermes-owned-v1";
const OWNED_ROOT = `skills/${NAMESPACE}`;

function parseArgs(argv) {
  const options = { action: "install", home: "", source: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--install" || argument === "--verify" || argument === "--uninstall") {
      options.action = argument.slice(2);
      continue;
    }
    if (argument === "--home" || argument === "--source") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a path`);
      options[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  if (!options.home) throw new Error("--home requires a path");
  if (options.action !== "uninstall" && !options.source) throw new Error("--source requires a path");
  return options;
}

function inside(root, path) {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel);
}

async function readDevSkills(sourceRoot) {
  const pluginRoot = join(sourceRoot, "plugins", "dev");
  const manifestPath = join(pluginRoot, ".claude-plugin", "plugin.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifest.name !== "dev") throw new Error(`${manifestPath}: name must be dev`);
  if (!Array.isArray(manifest.skills) || manifest.skills.length === 0) {
    throw new Error(`${manifestPath}: skills must be a non-empty array`);
  }

  const names = new Set();
  const skills = [];
  for (const declared of manifest.skills) {
    if (typeof declared !== "string" || !declared.startsWith("./skills/")) {
      throw new Error(`${manifestPath}: invalid skill path ${JSON.stringify(declared)}`);
    }
    const source = resolve(pluginRoot, declared);
    if (!inside(pluginRoot, source)) throw new Error(`${manifestPath}: skill escapes plugin root: ${declared}`);
    const name = basename(source);
    if (names.has(name)) throw new Error(`${manifestPath}: duplicate flattened Hermes skill name: ${name}`);
    names.add(name);
    const skillFile = await lstat(join(source, "SKILL.md")).catch(() => undefined);
    if (!skillFile?.isFile()) throw new Error(`${manifestPath}: declared skill is missing SKILL.md: ${declared}`);
    skills.push({ name, source });
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name, "en"));
}

async function describeTree(root, prefix = "") {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const metadata = await lstat(path);
    if (metadata.isDirectory()) {
      result.push([`${rel}/`, "directory"]);
      result.push(...await describeTree(path, rel));
    } else if (metadata.isSymbolicLink()) {
      result.push([rel, `link:${await readlink(path)}`]);
    } else if (metadata.isFile()) {
      result.push([rel, `file:${metadata.mode & 0o777}:${await readFile(path, "base64")}`]);
    } else {
      throw new Error(`unsupported skill entry type: ${path}`);
    }
  }
  return result.sort(([left], [right]) => left.localeCompare(right, "en"));
}

async function assertSkillCopy(source, target, name) {
  const expected = await describeTree(source);
  const actual = await describeTree(target).catch(() => undefined);
  if (!actual || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Hermes skill verification failed: ${name}`);
  }
}

function capabilities(skillCount) {
  return `# RedSkills dev capabilities for Hermes

Capability | Status | Detail
--- | --- | ---
Skills | healthy | ${skillCount} complete skill directories are available from the user-global Hermes skills tree.
Hooks | unsupported | Hermes has no RedSkills hook projection; no hook success is claimed.
MCP | unsupported | Hermes has no RedSkills MCP projection; no MCP success is claimed.
Agents | unsupported | Hermes has no RedSkills agent projection; no agent success is claimed.
`;
}

function reportReadiness() {
  process.stdout.write("Hermes readiness: skills=healthy\n");
  process.stdout.write("Hermes limitation: hooks=unsupported\n");
  process.stdout.write("Hermes limitation: mcp=unsupported\n");
  process.stdout.write("Hermes limitation: agents=unsupported\n");
}

async function install(source, home) {
  const sourceRoot = await realpath(resolve(source));
  const skills = await readDevSkills(sourceRoot);
  const target = join(home, OWNED_ROOT);
  const staging = join(home, `.${NAMESPACE}.tmp-${process.pid}`);
  await mkdir(home, { recursive: true });
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  try {
    for (const skill of skills) {
      const destination = join(staging, skill.name);
      await cp(skill.source, destination, { recursive: true, force: true, verbatimSymlinks: true });
      await assertSkillCopy(skill.source, destination, skill.name);
    }
    await writeFile(join(staging, "CAPABILITIES.md"), capabilities(skills.length));
    await mkdir(join(target, ".."), { recursive: true });
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
    await writeFile(join(home, OWNED_STATE), `${OWNED_HEADER}\n${OWNED_ROOT}\n`);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }

  await verify(sourceRoot, home);
}

async function verify(source, home) {
  const skills = await readDevSkills(source);
  const target = join(home, OWNED_ROOT);
  const owned = await readFile(join(home, OWNED_STATE), "utf8");
  if (owned !== `${OWNED_HEADER}\n${OWNED_ROOT}\n`) throw new Error("Hermes owned-state record is invalid");
  for (const skill of skills) await assertSkillCopy(skill.source, join(target, skill.name), skill.name);
  const capabilityReport = await readFile(join(target, "CAPABILITIES.md"), "utf8");
  if (capabilityReport !== capabilities(skills.length)) throw new Error("Hermes capability report has drifted");
  reportReadiness();
}

async function uninstall(home) {
  const statePath = join(home, OWNED_STATE);
  let state;
  try {
    state = await readFile(statePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    throw error;
  }
  const lines = state.trimEnd().split("\n");
  if (lines[0] !== OWNED_HEADER) throw new Error("refusing Hermes uninstall: owned-state header is invalid");
  for (const owned of lines.slice(1)) {
    if (owned !== OWNED_ROOT) throw new Error(`refusing Hermes uninstall: unexpected owned path ${JSON.stringify(owned)}`);
    const target = resolve(home, owned);
    if (!inside(resolve(home), target)) throw new Error("refusing Hermes uninstall: owned path escapes Hermes home");
    await rm(target, { recursive: true, force: true });
  }
  await rm(statePath, { force: true });
}

export async function runHermesSkillsInstaller(options) {
  const home = resolve(options.home);
  if (options.action === "uninstall") return uninstall(home);
  const source = await realpath(resolve(options.source));
  if (options.action === "verify") return verify(source, home);
  return install(source, home);
}

async function main() {
  await runHermesSkillsInstaller(parseArgs(process.argv.slice(2)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
