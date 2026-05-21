#!/usr/bin/env node
import { isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { readConfig, resolveNotesDir, resolveStoreUri } from "./config.js";
import { neighbors, path as shortestPath, search, traverse } from "./engine.js";
import { graphRecall } from "./graph-recall.js";
import { MemoryStore, factToNode } from "./graph-store.js";
import { ingestProject } from "./ingest.js";
import { initGraph, initMarkdownOnly } from "./init.js";
import { recall } from "./recall.js";
import { slugify, storeNote } from "./store.js";

const USAGE = `memory — persistent memory for code agents

Usage:
  memory init [--mode markdown-only|graph] [--root <dir>] [--yes]
  memory store <fact...>            [--root <dir>]
  memory recall <query...>          [--root <dir>] [--limit N]
  memory ingest <path>              [--root <dir>] [--max-files N]

  Graph-mode read verbs (require \`memory init --mode graph\`):
  memory search <query...>          [--root <dir>] [--limit N]
  memory neighbors <label>          [--root <dir>] [--depth N] [--direction outgoing|incoming|both]
  memory traverse <label>           [--root <dir>] [--depth N] [--strategy bfs|dfs] [--direction ...]
  memory path <from> <to>           [--root <dir>] [--algorithm bfs|dijkstra]
  memory stats                      [--root <dir>]

Two storage modes: markdown-only (plain notes, no engine) and graph (a typed
knowledge graph over a per-project RedDB store). Run \`memory init\` once to pick
one, then use /memory:store and /memory:recall (or the CLI verbs) — they route
to whichever mode init configured.`;

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
        "What do you want to use? [markdown-only] / graph (hybrid lands in a later release): ",
      )
    ).trim();
    rl.close();
    mode = answer || "markdown-only";
  }
  mode = mode ?? "markdown-only";

  if (mode === "markdown-only") {
    const result = await initMarkdownOnly(rootDir);
    console.log(`memory: initialized markdown-only mode`);
    console.log(`  config: ${result.configPath}`);
    console.log(`  notes:  ${result.notesDir}`);
    console.log(`  hooks:  off    mcp: off    reddb: not required`);
    return;
  }

  if (mode === "graph") {
    const result = await initGraph(rootDir);
    console.log(`memory: initialized graph mode`);
    console.log(`  config: ${result.configPath}`);
    console.log(`  store:  ${result.storeUri}`);
    console.log(`  hooks:  off    mcp: off    reddb: required`);
    return;
  }

  throw new Error(
    `mode "${mode}" is not available yet — this build supports markdown-only and graph`,
  );
}

async function runStore(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const fact = args.positional.join(" ").trim();
  if (!fact) throw new Error("nothing to store — pass a fact: memory store <fact>");
  const config = await requireConfig(rootDir);

  if (config.mode === "graph") {
    const store = await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
    try {
      const rid = await store.upsertNode(factToNode(fact, slugify));
      console.log(`memory: stored node ${rid}`);
    } finally {
      await store.close();
    }
    return;
  }

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

  if (config.mode === "graph") {
    const store = await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
    try {
      const hits = await graphRecall(store, query, limit);
      if (hits.length === 0) {
        console.log(`memory: no matches for "${query}"`);
        return;
      }
      console.log(`memory: ${hits.length} match(es) for "${query}"`);
      for (const hit of hits) {
        console.log(`  [${hit.score}] ${hit.id} (${hit.node_type}) ${hit.label}`);
        console.log(`        ${hit.excerpt}`);
      }
    } finally {
      await store.close();
    }
    return;
  }

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

async function runIngest(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const target = args.positional[0] ?? ".";
  const config = await requireConfig(rootDir);

  if (config.mode !== "graph") {
    throw new Error(
      `ingest needs graph mode — this project is "${config.mode}". Re-run \`memory init --mode graph\` first`,
    );
  }

  const cwd = isAbsolute(target) ? target : resolve(rootDir, target);
  const maxFiles =
    typeof args.flags["max-files"] === "string"
      ? Number(args.flags["max-files"])
      : undefined;

  const store = await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
  try {
    const report = await ingestProject(store, { cwd, maxFiles });
    console.log(`memory: ingested ${cwd}`);
    console.log(
      `  ${report.files} file(s) → ${report.nodes} node(s), ${report.edges} edge(s), ${report.docs} doc(s) in ${report.durationMs}ms`,
    );
  } finally {
    await store.close();
  }
}

/** Open the graph store for a read verb, erroring clearly outside graph mode. */
async function openGraphStore(args: ParsedArgs): Promise<{ store: MemoryStore }> {
  const rootDir = rootOf(args.flags);
  const config = await requireConfig(rootDir);
  if (config.mode !== "graph") {
    throw new Error(
      `this verb needs graph mode — this project is "${config.mode}". Re-run \`memory init --mode graph\` first`,
    );
  }
  return { store: await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) }) };
}

function intFlag(flags: Record<string, string | boolean>, key: string): number | undefined {
  return typeof flags[key] === "string" ? Number(flags[key]) : undefined;
}

function strFlag<T extends string>(
  flags: Record<string, string | boolean>,
  key: string,
  fallback: T,
): T {
  return typeof flags[key] === "string" ? (flags[key] as T) : fallback;
}

async function runSearch(args: ParsedArgs): Promise<void> {
  const query = args.positional.join(" ").trim();
  if (!query) throw new Error("nothing to search — pass a query: memory search <query>");
  const { store } = await openGraphStore(args);
  try {
    const hits = await search(store, query, intFlag(args.flags, "limit") ?? 20);
    if (hits.length === 0) return void console.log(`memory: no matches for "${query}"`);
    console.log(`memory: ${hits.length} match(es) for "${query}"`);
    for (const h of hits) {
      console.log(`  [${h.score}] ${h.rid} (${h.node_type}) ${h.label}`);
      console.log(`        ${h.excerpt}`);
    }
  } finally {
    await store.close();
  }
}

async function runNeighbors(args: ParsedArgs): Promise<void> {
  const label = args.positional[0];
  if (!label) throw new Error("pass a node label: memory neighbors <label>");
  const { store } = await openGraphStore(args);
  try {
    const rows = await neighbors(
      store,
      label,
      intFlag(args.flags, "depth") ?? 1,
      strFlag(args.flags, "direction", "both"),
    );
    console.log(`memory: ${rows.length} neighbor(s) of "${label}"`);
    for (const n of rows) console.log(`  d${n.depth} ${n.rid} (${n.node_type}) ${n.label}`);
  } finally {
    await store.close();
  }
}

async function runTraverse(args: ParsedArgs): Promise<void> {
  const label = args.positional[0];
  if (!label) throw new Error("pass a start label: memory traverse <label>");
  const { store } = await openGraphStore(args);
  try {
    const rows = await traverse(store, label, {
      depth: intFlag(args.flags, "depth") ?? 3,
      strategy: strFlag(args.flags, "strategy", "bfs"),
      direction: strFlag(args.flags, "direction", "outgoing"),
    });
    console.log(`memory: traversed ${rows.length} node(s) from "${label}"`);
    for (const n of rows) console.log(`  d${n.depth} ${n.rid} (${n.node_type}) ${n.label}`);
  } finally {
    await store.close();
  }
}

async function runPath(args: ParsedArgs): Promise<void> {
  const [from, to] = args.positional;
  if (!from || !to) throw new Error("pass two labels: memory path <from> <to>");
  const { store } = await openGraphStore(args);
  try {
    const result = await shortestPath(store, from, to, strFlag(args.flags, "algorithm", "bfs"));
    if (!result || !result.reachable) {
      console.log(`memory: no path from "${from}" to "${to}"`);
      return;
    }
    console.log(
      `memory: path "${from}" → "${to}": ${result.hopCount} hop(s), weight ${result.totalWeight}`,
    );
  } finally {
    await store.close();
  }
}

async function runStats(args: ParsedArgs): Promise<void> {
  const { store } = await openGraphStore(args);
  try {
    const stats = await store.stats();
    console.log(`memory: ${stats.nodes} node(s), ${stats.edges} edge(s)`);
  } finally {
    await store.close();
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
    case "ingest":
      return runIngest(args);
    case "search":
      return runSearch(args);
    case "neighbors":
      return runNeighbors(args);
    case "traverse":
      return runTraverse(args);
    case "path":
      return runPath(args);
    case "stats":
      return runStats(args);
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
