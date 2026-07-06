#!/usr/bin/env node
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import { McpStdioChannelBridge } from "./channel-bridge.js";
import { handleHook, type Runner } from "./hook-runtime.js";
import { ingestEvents } from "./ingest-events.js";
import { withBrainRuntime } from "./runtime.js";
import { brainAct } from "./brain-act.js";
import { buildBrainDashboard, buildBrainDashboardArtifact, serveBrainDashboardHtml } from "./dashboard.js";
import { ARTIFACT_KINDS, CONNECTION_KINDS } from "./schema.js";
import { loadIngestionState, saveIngestionState, scheduledIngest } from "./scheduled-ingestion.js";
import type { KpiGroupBy, KpiInterval, KpiTimeField } from "./kpi-query.js";
import { isOutcomeEvent } from "@reddb-io/shared/outcome-event.js";

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
    case "act":
      await act(args);
      return;
    case "hook":
      await hook(args);
      return;
    case "ingest-events":
      await ingestEventsCmd(args);
      return;
    case "schedule-ingest":
      await scheduleIngestCmd(args);
      return;
    case "kpi":
    case "kpis":
      await kpis(args);
      return;
    case "dashboard":
      await dashboard(args);
      return;
    case "outcome-event":
      await outcomeEvent(args);
      return;
    default:
      throw new Error(`unknown brain command: ${command}`);
  }
}

async function outcomeEvent(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand !== "record") throw new Error("brain outcome-event requires subcommand: record");
  const flags = parseFlags(rest);
  const input = await readStdin();
  const parsed = JSON.parse(input) as unknown;
  if (!isOutcomeEvent(parsed)) throw new Error("invalid brain outcome event");
  await withBrainRuntime(async ({ store }) => {
    printJson(await store.appendOutcomeEvent(parsed));
  }, stringFlag(flags, "root") ?? process.cwd());
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

async function scheduleIngestCmd(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const sessionKey = stringFlag(flags, "session-key") ?? stringFlag(flags, "session");
  const limit = numberFlag(flags, "limit");
  const bridge = await McpStdioChannelBridge.connect();
  try {
    await withBrainRuntime(async ({ config, store }) => {
      const statePath = stringFlag(flags, "state") ?? join(config.rootDir, ".red", "brain", "ingestion-state.json");
      const state = await loadIngestionState(statePath);
      const result = await scheduledIngest({
        bridge,
        store,
        state,
        sessionKey: sessionKey ?? undefined,
        limit: limit ?? undefined,
        sourceAgent: "brain.schedule-ingest",
      });
      await saveIngestionState(statePath, result.state);
      printJson(result);
    });
  } finally {
    await bridge.close().catch(() => {});
  }
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

async function kpis(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const interval = stringFlag(flags, "interval") as KpiInterval | undefined;
  const groupBy = stringFlag(flags, "group-by") as KpiGroupBy | undefined;
  const timeField = stringFlag(flags, "time-field") as KpiTimeField | undefined;
  await withBrainRuntime(async ({ store }) => {
    printJson(
      await store.eventKpis({
        interval,
        groupBy,
        timeField,
        from: stringFlag(flags, "from"),
        to: stringFlag(flags, "to"),
        platform: stringFlag(flags, "platform"),
        eventType: stringFlag(flags, "event-type"),
        target: stringFlag(flags, "target"),
      }),
    );
  });
}

async function dashboard(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const rendered = await withBrainRuntime(async ({ config, store, project }) => {
    const dashboard = await buildBrainDashboard(store, {
      project,
      rootDir: config.rootDir,
    });
    return {
      dashboard,
      artifact: buildBrainDashboardArtifact(dashboard),
      defaultOut: join(config.rootDir, ".red", "brain", "dashboard.html"),
    };
  });

  if (flags.json === true) {
    printJson(rendered.dashboard);
    return;
  }

  if (flags.serve === true) {
    const host = stringFlag(flags, "host") ?? "127.0.0.1";
    const port = numberFlag(flags, "port") ?? 4738;
    const server = await serveBrainDashboardHtml(rendered.artifact.html, { host, port });
    const address = server.address() as AddressInfo;
    console.log(`brain: dashboard serving at http://${address.address}:${address.port}/`);
    await new Promise<void>((resolve) => {
      const stop = () => server.close(() => resolve());
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return;
  }

  const out = stringFlag(flags, "out") ?? rendered.defaultOut;
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, rendered.artifact.html, "utf8");
  console.log(`brain: dashboard written ${out}`);
}

async function act(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const target = stringFlag(flags, "target") ?? flags._[0];
  const message = stringFlag(flags, "message") ?? flags._.slice(1).join(" ");
  if (!target) throw new Error("brain act requires --target <channel>");
  if (!message) throw new Error("brain act requires --message <text>");
  printJson(await brainAct({ target, message }));
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

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
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
  act --target <channel> --message <text>
  ingest-events [--after-cursor N] [--session-key KEY] [--limit N]
  schedule-ingest [--session-key KEY] [--limit N] [--state PATH]
  kpi [--interval hour|day|week|month] [--group-by platform|event_type|target] [--time-field event|ingested] [--from T] [--to T] [--platform P] [--event-type T] [--target T]
  dashboard [--out PATH] [--json] [--serve] [--host 127.0.0.1] [--port 4738]
  outcome-event record [--root PATH] < event.json
`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
