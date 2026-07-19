#!/usr/bin/env node
// scripts/publish-pi-packages.mjs — publish the staged Pi packages to npm.
//
// Reads the per-plugin package.json under packaging/pi/<name>/ and runs
// `npm publish` once per plugin with idempotent "already on the registry"
// detection (ADR 0110 + the contract used by @reddb-io/red-skills in
// .github/workflows/red-release.yml). Reads NPM_TOKEN from the environment
// (CI exports it from secrets; local development can set it manually).
//
// Usage:
//   node scripts/publish-pi-packages.mjs                       # publish all
//   node scripts/publish-pi-packages.mjs --dry-run            # print, no push
//   node scripts/publish-pi-packages.mjs --plugin dev,memory   # subset
//
// Exit codes: 0 all succeeded or already-published; 1 publish failure; 2 usage.

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGING_ROOT = "packaging/pi";

function parseArgs(argv) {
  const args = { dryRun: false, plugin: null, root: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (arg === "--plugin") {
      const next = argv[index + 1];
      if (!next) throw new Error("--plugin requires a comma list");
      args.plugin = next.split(",").map((s) => s.trim()).filter(Boolean);
      index += 1;
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

function listStagedPlugins(root) {
  const dir = join(root, PACKAGING_ROOT);
  return readdirSync(dir).filter((entry) => {
    try {
      return statSync(join(dir, entry)).isDirectory();
    } catch {
      return false;
    }
  });
}

function readPackageJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function npmViewPublished(spec) {
  // npm view exits 0 when the version is present in the registry and non-zero
  // when it is not. We treat 0 as "already on the registry" and skip the
  // publish. stderr is captured to keep the script's stdout clean.
  return spawnSync("npm", ["view", spec, "version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function npmPublish(pkgDir, dryRun) {
  if (dryRun) {
    return { status: 0, stdout: `(dry-run) pnpm --dir ${pkgDir} publish --access public --no-git-checks`, stderr: "" };
  }
  return spawnSync("pnpm", ["--dir", pkgDir, "publish", "--access", "public", "--no-git-checks"], {
    encoding: "utf8",
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, npm_config_yes: "true" },
  });
}

export async function publishPiPackages({ root, dryRun = false, plugin = null }) {
  const all = listStagedPlugins(root);
  const targets = plugin ? all.filter((name) => plugin.includes(name)) : all;
  if (targets.length === 0) {
    throw new Error(`no staged Pi packages found under ${PACKAGING_ROOT}/`);
  }

  let okCount = 0;
  let alreadyCount = 0;
  let failCount = 0;

  for (const pluginName of targets) {
    const pkgDir = join(root, PACKAGING_ROOT, pluginName);
    const pkgJson = readPackageJson(join(pkgDir, "package.json"));
    const spec = `${pkgJson.name}@${pkgJson.version}`;

    if (!dryRun && !process.env.NODE_AUTH_TOKEN && !process.env.NPM_TOKEN) {
      console.error(`publish-pi: warn: NODE_AUTH_TOKEN/NPM_TOKEN not set; ${spec} publish may fail`);
    }

    const probe = npmViewPublished(spec);
    if (probe.status === 0) {
      console.log(`publish-pi: ${spec} already on the registry — skip`);
      alreadyCount += 1;
      continue;
    }

    console.log(`publish-pi: publishing ${spec} from ${pkgDir}`);
    const result = npmPublish(pkgDir, dryRun);
    if (result.status !== 0) {
      console.error(`publish-pi: ${spec} failed (exit ${result.status})`);
      failCount += 1;
      continue;
    }
    okCount += 1;
  }

  const summary = `publish-pi: ${okCount} published, ${alreadyCount} already-on-registry, ${failCount} failed`;
  console.log(summary);
  if (failCount > 0) {
    throw new Error(summary);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await publishPiPackages(args);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}