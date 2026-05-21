#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { readConfig, resolveNotesDir } from "./config.js";
import { initMarkdownOnly } from "./init.js";
import { recall } from "./recall.js";
import { storeNote } from "./store.js";

const USAGE = `memory — persistent markdown memory for code agents

Usage:
  memory init [--mode markdown-only] [--root <dir>] [--yes]
  memory store <fact...>            [--root <dir>]
  memory recall <query...>          [--root <dir>] [--limit N]

This build ships the markdown-only path. Run \`memory init\` once, then use
/memory:store and /memory:recall (or the CLI verbs) to round-trip facts.`;

interface ParsedArgs {
  command: string | undefined;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { command, positional, flags };
}

function rootOf(flags: Record<string, string | boolean>): string {
  return typeof flags.root === "string" ? flags.root : process.cwd();
}

async function requireConfig(rootDir: string) {
  const config = await readConfig(rootDir);
  if (!config) {
    throw new Error("memory is not initialized here — run `memory init` first");
  }
  return config;
}

async function runInit(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  let mode = typeof args.flags.mode === "string" ? args.flags.mode : undefined;

  // Interactive wizard only when no mode was given and we have a TTY.
  if (!mode && args.flags.yes !== true && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (
      await rl.question(
        "What do you want to use? [markdown-only] (graph/hybrid land in later releases): ",
      )
    ).trim();
    rl.close();
    mode = answer || "markdown-only";
  }
  mode = mode ?? "markdown-only";

  if (mode !== "markdown-only") {
    throw new Error(
      `mode "${mode}" is not available yet — this build only supports markdown-only`,
    );
  }

  const result = await initMarkdownOnly(rootDir);
  console.log(`memory: initialized markdown-only mode`);
  console.log(`  config: ${result.configPath}`);
  console.log(`  notes:  ${result.notesDir}`);
  console.log(`  hooks:  off    mcp: off    reddb: not required`);
}

async function runStore(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const fact = args.positional.join(" ").trim();
  if (!fact) throw new Error("nothing to store — pass a fact: memory store <fact>");
  const config = await requireConfig(rootDir);
  const note = await storeNote(resolveNotesDir(rootDir, config), fact);
  console.log(`memory: stored ${note.id}`);
  console.log(`  ${note.path}`);
}

async function runRecall(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const query = args.positional.join(" ").trim();
  if (!query) throw new Error("nothing to recall — pass a query: memory recall <query>");
  const config = await requireConfig(rootDir);
  const limit = typeof args.flags.limit === "string" ? Number(args.flags.limit) : 10;
  const hits = await recall(resolveNotesDir(rootDir, config), query, limit);
  if (hits.length === 0) {
    console.log(`memory: no matches for "${query}"`);
    return;
  }
  console.log(`memory: ${hits.length} match(es) for "${query}"`);
  for (const hit of hits) {
    console.log(`  [${hit.score}] ${hit.id}`);
    console.log(`        ${hit.excerpt}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "init":
      return runInit(args);
    case "store":
      return runStore(args);
    case "recall":
      return runRecall(args);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return;
    default:
      throw new Error(`unknown command: ${args.command}\n\n${USAGE}`);
  }
}

main().catch((err: unknown) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
