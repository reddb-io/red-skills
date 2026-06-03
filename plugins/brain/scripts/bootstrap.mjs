#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, "..");
const repoRoot = resolve(pluginRoot, "..", "..");

function candidateEntrypoints(kind) {
  const file = kind === "mcp" || kind === "brain-mcp" ? "brain-mcp.mjs" : "brain-cli.mjs";
  const source = kind === "mcp" || kind === "brain-mcp" ? "src/mcp-server.ts" : "src/cli.ts";
  return [
    { command: process.execPath, args: [join(pluginRoot, "dist-bundle", file)] },
    { command: process.execPath, args: [join(repoRoot, "src/apps/brain/dist-bundle", file)] },
    { command: process.execPath, args: ["--import", "tsx", join(repoRoot, "src/apps/brain", source)] },
  ];
}

function delegate(argv) {
  const kind = argv[0] === "mcp" || argv[0] === "brain-mcp" ? "mcp" : "cli";
  const extra = kind === "mcp" ? argv.slice(1) : argv;
  const env = { ...process.env };
  if (!env.REDDB_BIN) {
    const localRed = join(repoRoot, "node_modules/.pnpm/@reddb-io+sdk@1.7.0/node_modules/@reddb-io/sdk/bin", process.platform === "win32" ? "red.exe" : "red");
    if (existsSync(localRed)) env.REDDB_BIN = localRed;
  }
  for (const candidate of candidateEntrypoints(kind)) {
    const entry = candidate.args[candidate.args.length - 1];
    if (!existsSync(entry)) continue;
    const child = spawn(candidate.command, [...candidate.args, ...extra], {
      stdio: "inherit",
      env,
    });
    child.on("exit", (code) => process.exit(code ?? 0));
    child.on("error", () => process.exit(1));
    return;
  }
  process.stderr.write("brain: no runnable bundle found; run pnpm --filter @reddb-io/brain build\\n");
  process.stdout.write("{}");
}

delegate(process.argv.slice(2));
