#!/usr/bin/env node

import { chmod, cp, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MCP_BUNDLES = [
  ["navigator", "code-nav-mcp.bundle.min.mjs", ["code-nav-mcp.bundle.min.mjs", "code-nav.bundle.min.mjs"], []],
  ["redskilled", "redskilled-mcp.bundle.min.mjs", ["redskilled-mcp.bundle.min.mjs"], []],
  ["rsp", "rsp.bundle.min.mjs", ["rsp.bundle.min.mjs"], ["mcp"]],
];

function parseArgs(argv) {
  const args = { root: process.cwd(), output: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root" || arg === "--output") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a path`);
      args[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.output) throw new Error("--output requires a path");
  return args;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function requireFile(path, label) {
  let metadata;
  try {
    metadata = await stat(path);
  } catch {
    throw new Error(`${label} not found: ${path}`);
  }
  if (!metadata.isFile()) throw new Error(`${label} is not a file: ${path}`);
}

function within(root, path) {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel);
}

function extensionPath(...parts) {
  return ["${extensionPath}", ...parts].join("${/}");
}

function jsonBytes(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function buildGeminiExtension({ root, output }) {
  const sourceRoot = await realpath(resolve(root));
  const pluginRoot = join(sourceRoot, "plugins", "dev");
  const claudeManifestPath = join(pluginRoot, ".claude-plugin", "plugin.json");
  const claude = await readJson(claudeManifestPath);
  if (claude.name !== "dev") throw new Error(`${claudeManifestPath}: name must be dev`);
  if (typeof claude.version !== "string" || !claude.version) {
    throw new Error(`${claudeManifestPath}: version must be a non-empty string`);
  }
  if (typeof claude.description !== "string" || !claude.description) {
    throw new Error(`${claudeManifestPath}: description must be a non-empty string`);
  }
  if (!Array.isArray(claude.skills) || claude.skills.length === 0) {
    throw new Error(`${claudeManifestPath}: skills must be a non-empty array`);
  }

  const target = resolve(output);
  const staging = `${target}.tmp-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(join(staging, "skills"), { recursive: true });
  await mkdir(join(staging, "hooks"), { recursive: true });
  await mkdir(join(staging, "dist"), { recursive: true });

  const skillNames = new Set();
  for (const declared of claude.skills) {
    if (typeof declared !== "string" || !declared.startsWith("./skills/")) {
      throw new Error(`${claudeManifestPath}: invalid skill path ${JSON.stringify(declared)}`);
    }
    const source = resolve(pluginRoot, declared);
    if (!within(pluginRoot, source)) {
      throw new Error(`${claudeManifestPath}: skill escapes plugin root: ${declared}`);
    }
    await requireFile(join(source, "SKILL.md"), `declared skill ${declared}`);
    const name = basename(source);
    if (skillNames.has(name)) {
      throw new Error(`${claudeManifestPath}: duplicate flattened Gemini skill name: ${name}`);
    }
    skillNames.add(name);
    await cp(source, join(staging, "skills", name), { recursive: true, force: true });
  }

  const guardSource = join(pluginRoot, "hooks", "command-guard.sh");
  await requireFile(guardSource, "Gemini command guard hook");
  await cp(guardSource, join(staging, "hooks", "command-guard.sh"), { force: true });
  await chmod(join(staging, "hooks", "command-guard.sh"), 0o755);

  const mcpServers = {};
  for (const [name, bundle, sourceNames, trailingArgs] of MCP_BUNDLES) {
    let source = "";
    for (const sourceName of sourceNames) {
      const candidate = join(sourceRoot, "dist", sourceName);
      try {
        await requireFile(candidate, `Gemini ${name} MCP bundle`);
        source = candidate;
        break;
      } catch {
        // Try the next canonical package-set spelling.
      }
    }
    if (!source) {
      throw new Error(`Gemini ${name} MCP bundle not found: ${sourceNames.join(", ")}`);
    }
    await cp(source, join(staging, "dist", bundle), { force: true });
    mcpServers[name] = {
      command: "node",
      args: [extensionPath("dist", bundle), ...trailingArgs],
      cwd: "${extensionPath}",
    };
  }

  await writeFile(
    join(staging, "gemini-extension.json"),
    jsonBytes({
      name: "dev",
      version: claude.version,
      description: String(claude.description)
        .replace(/[‘’`]/g, "")
        .replace(/[“”]/g, '"')
        .replace(/[–—]/g, "-")
        .replace(/…/g, "...")
        .replace(/\s+/g, " ")
        .trim(),
      mcpServers,
    }),
  );
  await writeFile(
    join(staging, "hooks", "hooks.json"),
    jsonBytes({
      hooks: {
        BeforeTool: [
          {
            matcher: "run_shell_command",
            hooks: [
              {
                type: "command",
                command: extensionPath("hooks", "command-guard.sh"),
                description: "Enforce RedSkills command and worktree guardrails",
              },
            ],
          },
        ],
      },
    }),
  );

  await mkdir(dirname(target), { recursive: true });
  await rm(target, { recursive: true, force: true });
  await rename(staging, target);
}

async function main() {
  await buildGeminiExtension(parseArgs(process.argv.slice(2)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
