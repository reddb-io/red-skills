#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NATIVE_FIELDS = new Set(["name", "version", "description", "mcpServers"]);
const HOOK_FIELDS = new Set(["hooks"]);

function parseArgs(argv) {
  let extension = "";
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--extension") throw new Error(`unknown argument: ${argv[index]}`);
    extension = argv[index + 1] ?? "";
    if (!extension) throw new Error("--extension requires a path");
    index += 1;
  }
  if (!extension) throw new Error("--extension requires a path");
  return resolve(extension);
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function fileMetadata(path, label) {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error(`${label} is not a file: ${path}`);
    return metadata;
  } catch (error) {
    if (error instanceof Error && error.message.includes("is not a file")) throw error;
    throw new Error(`${label} not found: ${path}`);
  }
}

async function directoryEntries(path, label) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    throw new Error(`${label} not found: ${path}`);
  }
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertOnlyKeys(object, allowed, label) {
  const invalid = Object.keys(object).filter((key) => !allowed.has(key));
  if (invalid.length > 0) throw new Error(`${label} contains unsupported field(s): ${invalid.join(", ")}`);
}

function resolveExtensionReference(extensionRoot, value, owner) {
  const prefix = "${extensionPath}${/}";
  if (typeof value !== "string" || !value.startsWith(prefix)) {
    throw new Error(`${owner} must use a ${prefix} path`);
  }
  const tail = value.slice(prefix.length).replaceAll("${/}", "/");
  if (!tail || tail.includes("${") || tail.includes("\0")) {
    throw new Error(`${owner} has an invalid extension path: ${value}`);
  }
  const target = resolve(extensionRoot, tail);
  const rel = relative(extensionRoot, target);
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new Error(`${owner} escapes the extension root: ${value}`);
  }
  return { target, relative: rel };
}

async function validateLegacy(extensionRoot) {
  const manifestPath = join(extensionRoot, ".gemini-plugin", "plugin.json");
  const manifest = await readJson(manifestPath);
  for (const field of ["hooks", "mcpServers"]) {
    const value = manifest[field];
    if (typeof value !== "string" || !value.startsWith("./")) continue;
    const target = resolve(extensionRoot, value.slice(2));
    try {
      await fileMetadata(target, `legacy Gemini ${field} path ${value}`);
    } catch {
      throw new Error(`${value.slice(2)}: legacy Gemini ${field} path is dangling`);
    }
  }
  throw new Error(`${manifestPath}: native gemini-extension.json not found`);
}

async function validateNativeManifest(extensionRoot) {
  const path = join(extensionRoot, "gemini-extension.json");
  let manifest;
  try {
    manifest = await readJson(path);
  } catch (error) {
    try {
      await fileMetadata(join(extensionRoot, ".gemini-plugin", "plugin.json"), "legacy manifest");
      return validateLegacy(extensionRoot);
    } catch (legacyError) {
      if (legacyError instanceof Error && legacyError.message.includes("legacy Gemini")) throw legacyError;
      throw error;
    }
  }
  assertObject(manifest, "gemini-extension.json");
  assertOnlyKeys(manifest, NATIVE_FIELDS, "gemini-extension.json");
  if (manifest.name !== "dev") throw new Error("gemini-extension.json name must be dev");
  for (const field of ["version", "description"]) {
    if (typeof manifest[field] !== "string" || !manifest[field]) {
      throw new Error(`gemini-extension.json ${field} must be a non-empty string`);
    }
  }
  assertObject(manifest.mcpServers, "gemini-extension.json mcpServers");
  const serverNames = Object.keys(manifest.mcpServers).sort();
  if (serverNames.join(",") !== "redskilled") {
    throw new Error("gemini-extension.json must declare exactly the redskilled MCP server");
  }
  for (const name of serverNames) {
    const server = manifest.mcpServers[name];
    assertObject(server, `MCP server ${name}`);
    if (server.command !== "node") throw new Error(`MCP server ${name} command must be node`);
    if (!Array.isArray(server.args) || server.args.length === 0) {
      throw new Error(`MCP server ${name} args must be a non-empty array`);
    }
    if (server.cwd !== "${extensionPath}") {
      throw new Error(`MCP server ${name} cwd must be \${extensionPath}`);
    }
    const reference = resolveExtensionReference(extensionRoot, server.args[0], `MCP server ${name} entrypoint`);
    await fileMetadata(reference.target, `MCP server ${name} entrypoint ${reference.relative}`);
  }
}

async function validateHooks(extensionRoot) {
  const path = join(extensionRoot, "hooks", "hooks.json");
  const manifest = await readJson(path);
  assertObject(manifest, "hooks/hooks.json");
  assertOnlyKeys(manifest, HOOK_FIELDS, "hooks/hooks.json");
  assertObject(manifest.hooks, "hooks/hooks.json hooks");
  if (Object.keys(manifest.hooks).join(",") !== "BeforeTool") {
    throw new Error("hooks/hooks.json must contain only the Gemini BeforeTool event");
  }
  const groups = manifest.hooks.BeforeTool;
  if (!Array.isArray(groups) || groups.length !== 1) {
    throw new Error("hooks/hooks.json BeforeTool must contain one hook group");
  }
  const group = groups[0];
  assertObject(group, "Gemini BeforeTool hook group");
  if (group.matcher !== "run_shell_command") {
    throw new Error("Gemini BeforeTool matcher must be run_shell_command");
  }
  if (!Array.isArray(group.hooks) || group.hooks.length !== 1) {
    throw new Error("Gemini BeforeTool group must contain one command hook");
  }
  const hook = group.hooks[0];
  assertObject(hook, "Gemini BeforeTool command hook");
  if (hook.type !== "command") throw new Error("Gemini BeforeTool hook type must be command");
  const reference = resolveExtensionReference(extensionRoot, hook.command, "Gemini BeforeTool command");
  const metadata = await fileMetadata(reference.target, `Gemini hook ${reference.relative}`);
  if ((metadata.mode & 0o111) === 0) {
    throw new Error(`Gemini hook ${reference.relative} is not executable`);
  }
}

async function validateSkills(extensionRoot) {
  const skillsRoot = join(extensionRoot, "skills");
  const entries = await directoryEntries(skillsRoot, "Gemini skills directory");
  const skills = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."));
  if (skills.length === 0) throw new Error("skills: Gemini extension contains no skills");
  for (const skill of skills) {
    const relativePath = `skills/${skill.name}/SKILL.md`;
    await fileMetadata(join(skillsRoot, skill.name, "SKILL.md"), `Gemini skill ${relativePath}`);
  }
}

export async function validateGeminiExtension(extensionRoot) {
  await validateNativeManifest(extensionRoot);
  await validateHooks(extensionRoot);
  await validateSkills(extensionRoot);
}

async function main() {
  const extensionRoot = parseArgs(process.argv.slice(2));
  await validateGeminiExtension(extensionRoot);
  console.log("Gemini dev extension metadata ok");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
