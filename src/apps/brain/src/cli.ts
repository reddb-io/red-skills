#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { McpStdioChannelBridge } from "./channel-bridge.js";
import { handleHook, type Runner } from "./hook-runtime.js";
import { ingestEvents } from "./ingest-events.js";
import { withBrainRuntime } from "./runtime.js";
import { ARTIFACT_KINDS, CONNECTION_KINDS } from "./schema.js";

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    case "init":
      await withBrainRuntime(async ({ config, store }) => {
        const status = await store.status();
        printJson({ rootDir: config.rootDir, configPath: config.configPath, ...status });
      });
      return;
    case "status":
      await withBrainRuntime(async ({ config, store }) => {
        printJson({ rootDir: config.rootDir, configPath: config.configPath, ...(await store.status()) });
      });
      return;
    case "capture":
      await capture(args);
      return;
    case "search":
      await search(args);
      return;
    case "think":
    case "query":
      await think(args);
      return;
    case "get":
      await get(args);
      return;
    case "link":
      await link(args);
      return;
    case "backlinks":
      await backlinks(args);
      return;
    case "hook":
      await hook(args);
      return;
    case "ingest-events":
      await ingestEventsCmd(args);
      return;
    default:
      throw new Error(`unknown brain command: ${command}`);
  }
}

async function capture(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const title = (stringFlag(flags, "title") ?? flags._.join(" ").slice(0, 80)) || "Untitled artifact";
  const content = stringFlag(flags, "content") ?? (stringFlag(flags, "file") ? await readFile(String(stringFlag(flags, "file")), "utf8") : flags._.join(" "));
  if (!content.trim()) throw new Error("brain capture requires content, --content, or --file");
  await withBrainRuntime(async ({ store }) => {
    const artifact = await store.capture({
      title,
      content,
      kind: stringFlag(flags, "kind") ?? "note",
      tags: listFlag(flags, "tag"),
      sourceAgent: stringFlag(flags, "agent"),
      sourceRunner: stringFlag(flags, "runner"),
      sourceSession: stringFlag(flags, "session"),
      sourcePath: process.cwd(),
    });
    printJson(artifact);
  });
}

async function search(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const query = stringFlag(flags, "query") ?? flags._.join(" ");
  if (!query) throw new Error("brain search requires a query");
  const limit = numberFlag(flags, "limit") ?? 10;
  await withBrainRuntime(async ({ store }) => printJson(await store.search(query, limit)));
}

async function think(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const query = stringFlag(flags, "query") ?? flags._.join(" ");
  if (!query) throw new Error("brain think requires a query");
  const limit = numberFlag(flags, "limit") ?? 8;
  await withBrainRuntime(async ({ store }) => {
    const result = await store.think(query, limit);
    if (flags.json === true) printJson(result);
    else console.log(result.answer);
  });
}

async function get(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) throw new Error("brain get requires a rid or artifact id");
  await withBrainRuntime(async ({ store }) => {
    const artifact = await store.getArtifact(parseRidOrId(id));
    if (!artifact) throw new Error(`Brain artifact not found: ${id}`);
    printJson(artifact);
  });
}

async function link(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const from = stringFlag(flags, "from");
  const to = stringFlag(flags, "to");
  if (!from || !to) throw new Error("brain link requires --from and --to");
  await withBrainRuntime(async ({ store }) => {
    printJson(
      await store.link({
        from: parseRidOrId(from),
        to: parseRidOrId(to),
        kind: stringFlag(flags, "kind") ?? "related_to",
        reason: stringFlag(flags, "reason"),
      }),
    );
  });
}

async function backlinks(args: string[]): Promise<void> {
  const target = args[0];
  if (!target) throw new Error("brain backlinks requires a rid or artifact id");
  await withBrainRuntime(async ({ store }) => printJson(await store.backlinks(parseRidOrId(target))));
}

async function ingestEventsCmd(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const afterCursor = stringFlag(flags, "after-cursor") ?? stringFlag(flags, "cursor");
  const sessionKey = stringFlag(flags, "session-key") ?? stringFlag(flags, "session");
  const limit = numberFlag(flags, "limit");
  const bridge = await McpStdioChannelBridge.connect();
  try {
    await withBrainRuntime(async ({ store }) => {
      const result = await ingestEvents({
        bridge,
        store,
        afterCursor: afterCursor ?? undefined,
        sessionKey: sessionKey ?? undefined,
        limit: limit ?? undefined,
        sourceAgent: "brain.ingest-events",
      });
      printJson(result);
    });
  } finally {
    await bridge.close().catch(() => {});
  }
}

async function hook(args: string[]): Promise<void> {
  const [lifecycle = "SessionStart", ...rest] = args;
  const flags = parseFlags(rest);
  const runner = (stringFlag(flags, "runner") ?? "unknown") as Runner;
  printJson(await handleHook(lifecycle, runner));
}

function parseRidOrId(value: string): number | string {
  return /^\d+$/.test(value) ? Number(value) : value;
}

type Flags = Record<string, string | string[] | boolean> & { _: string[] };

function parseFlags(args: string[]): Flags {
  const flags: Flags = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      flags._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = args[i + 1];
    const value = next && !next.startsWith("--") ? args[++i] : true;
    const prev = flags[key];
    if (prev == null || prev === false) flags[key] = value;
    else if (Array.isArray(prev)) prev.push(String(value));
    else flags[key] = [String(prev), String(value)];
  }
  return flags;
}

function stringFlag(flags: Flags, key: string): string | undefined {
  const value = flags[key];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[value.length - 1];
  return undefined;
}

function listFlag(flags: Flags, key: string): string[] {
  const value = flags[key];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value;
  return [];
}

function numberFlag(flags: Flags, key: string): number | undefined {
  const value = stringFlag(flags, key);
  if (value == null) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${key} must be a number`);
  return parsed;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printHelp(): void {
  console.log(`brain commands:
  init
  status
  capture [text] --title <title> --kind <${ARTIFACT_KINDS.join("|")}> --tag <tag>
  search <query> [--limit N]
  think <query> [--limit N] [--json]
  get <rid|id>
  link --from <rid|id> --to <rid|id> --kind <${CONNECTION_KINDS.join("|")}>
  backlinks <rid|id>
  ingest-events [--after-cursor N] [--session-key KEY] [--limit N]
`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
