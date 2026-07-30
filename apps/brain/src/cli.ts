#!/usr/bin/env node
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import { readBuildInfo, renderVersion } from "@reddb-io/build-info";
import { McpStdioChannelBridge } from "./channel-bridge.js";
import { handleHook, type Runner } from "./hook-runtime.js";
import { ingestEvents } from "./ingest-events.js";
import { withBrainRuntime } from "./runtime.js";
import { brainAct } from "./brain-act.js";
import { buildBrainDashboard, buildBrainDashboardArtifact, serveBrainDashboardHtml } from "./dashboard.js";
import { loadIngestionState, saveIngestionState, scheduledIngest } from "./scheduled-ingestion.js";
import type { KpiGroupBy, KpiInterval, KpiTimeField } from "./kpi-query.js";
import { isOutcomeEvent } from "@reddb-io/shared/outcome-event.js";
import {
  ACT_FLAGS,
  BRAIN_BINARY_FLAGS,
  BRAIN_USAGE,
  CAPTURE_FLAGS,
  DASHBOARD_FLAGS,
  HOOK_FLAGS,
  INGEST_EVENTS_FLAGS,
  KPI_FLAGS,
  LINK_FLAGS,
  NO_FLAGS,
  OUTCOME_EVENT_FLAGS,
  parseBrainFlags,
  routeBrainCommand,
  SCHEDULE_INGEST_FLAGS,
  SEARCH_FLAGS,
  THINK_FLAGS,
} from "./cli-args.js";

async function main(): Promise<void> {
  const { command, args } = routeBrainCommand(process.argv.slice(2));
  switch (command) {
    case "help":
    case "version": {
      // Answered before config, enablement, or any store or socket: "which
      // build is this?" and "what can it do?" must stay answerable in a
      // directory that never ran `brain init`, which is where they get asked.
      const { values } = parseBrainFlags(args, BRAIN_BINARY_FLAGS);
      if (command === "version" || values.version === true) {
        printVersion(values.json === true);
        return;
      }
      console.log(BRAIN_USAGE);
      return;
    }
    case "init":
      parseBrainFlags(args, NO_FLAGS);
      await withBrainRuntime(async ({ config, store }) => {
        const status = await store.status();
        printJson({ rootDir: config.rootDir, configPath: config.configPath, ...status });
      });
      return;
    case "status":
      parseBrainFlags(args, NO_FLAGS);
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
      await kpis(args);
      return;
    case "dashboard":
      await dashboard(args);
      return;
    case "outcome-event":
      await outcomeEvent(args);
      return;
  }
}

/** Print the build version — the answer this binary owes before anything else. */
function printVersion(asJson: boolean): void {
  const info = readBuildInfo("brain");
  process.stdout.write(asJson ? `${JSON.stringify(info)}\n` : `${renderVersion(info)}\n`);
}

async function outcomeEvent(args: string[]): Promise<void> {
  const { values, positionals } = parseBrainFlags(args, OUTCOME_EVENT_FLAGS);
  if (positionals[0] !== "record") throw new Error("brain outcome-event requires subcommand: record");
  const input = await readStdin();
  const parsed = JSON.parse(input) as unknown;
  if (!isOutcomeEvent(parsed)) throw new Error("invalid brain outcome event");
  await withBrainRuntime(async ({ store }) => {
    printJson(await store.appendOutcomeEvent(parsed));
  }, values.root ?? process.cwd());
}

async function capture(args: string[]): Promise<void> {
  const { values, positionals } = parseBrainFlags(args, CAPTURE_FLAGS);
  const title = (values.title ?? positionals.join(" ").slice(0, 80)) || "Untitled artifact";
  const content = values.content ?? (values.file ? await readFile(values.file, "utf8") : positionals.join(" "));
  if (!content.trim()) throw new Error("brain capture requires content, --content, or --file");
  await withBrainRuntime(async ({ store }) => {
    const artifact = await store.capture({
      title,
      content,
      kind: values.kind ?? "note",
      tags: values.tag ?? [],
      sourceAgent: values.agent,
      sourceRunner: values.runner,
      sourceSession: values.session,
      sourcePath: process.cwd(),
    });
    printJson(artifact);
  });
}

async function search(args: string[]): Promise<void> {
  const { values, positionals } = parseBrainFlags(args, SEARCH_FLAGS);
  const query = values.query ?? positionals.join(" ");
  if (!query) throw new Error("brain search requires a query");
  const limit = values.limit ?? 10;
  await withBrainRuntime(async ({ store }) => printJson(await store.search(query, limit)));
}

async function think(args: string[]): Promise<void> {
  const { values, positionals } = parseBrainFlags(args, THINK_FLAGS);
  const query = values.query ?? positionals.join(" ");
  if (!query) throw new Error("brain think requires a query");
  const limit = values.limit ?? 8;
  await withBrainRuntime(async ({ store }) => {
    const result = await store.think(query, limit);
    if (values.json === true) printJson(result);
    else console.log(result.answer);
  });
}

async function get(args: string[]): Promise<void> {
  const { positionals } = parseBrainFlags(args, NO_FLAGS);
  const id = positionals[0];
  if (!id) throw new Error("brain get requires a rid or artifact id");
  await withBrainRuntime(async ({ store }) => {
    const artifact = await store.getArtifact(parseRidOrId(id));
    if (!artifact) throw new Error(`Brain artifact not found: ${id}`);
    printJson(artifact);
  });
}

async function link(args: string[]): Promise<void> {
  const { values } = parseBrainFlags(args, LINK_FLAGS);
  const from = values.from;
  const to = values.to;
  if (!from || !to) throw new Error("brain link requires --from and --to");
  await withBrainRuntime(async ({ store }) => {
    printJson(
      await store.link({
        from: parseRidOrId(from),
        to: parseRidOrId(to),
        kind: values.kind ?? "related_to",
        reason: values.reason,
      }),
    );
  });
}

async function backlinks(args: string[]): Promise<void> {
  const { positionals } = parseBrainFlags(args, NO_FLAGS);
  const target = positionals[0];
  if (!target) throw new Error("brain backlinks requires a rid or artifact id");
  await withBrainRuntime(async ({ store }) => printJson(await store.backlinks(parseRidOrId(target))));
}

async function scheduleIngestCmd(args: string[]): Promise<void> {
  const { values } = parseBrainFlags(args, SCHEDULE_INGEST_FLAGS);
  const bridge = await McpStdioChannelBridge.connect();
  try {
    await withBrainRuntime(async ({ config, store }) => {
      const statePath = values.state ?? join(config.rootDir, ".red", "brain", "ingestion-state.json");
      const state = await loadIngestionState(statePath);
      const result = await scheduledIngest({
        bridge,
        store,
        state,
        sessionKey: values["session-key"],
        limit: values.limit,
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
  const { values } = parseBrainFlags(args, INGEST_EVENTS_FLAGS);
  const bridge = await McpStdioChannelBridge.connect();
  try {
    await withBrainRuntime(async ({ store }) => {
      const result = await ingestEvents({
        bridge,
        store,
        afterCursor: values["after-cursor"],
        sessionKey: values["session-key"],
        limit: values.limit,
        sourceAgent: "brain.ingest-events",
      });
      printJson(result);
    });
  } finally {
    await bridge.close().catch(() => {});
  }
}

async function kpis(args: string[]): Promise<void> {
  const { values } = parseBrainFlags(args, KPI_FLAGS);
  await withBrainRuntime(async ({ store }) => {
    printJson(
      await store.eventKpis({
        interval: values.interval as KpiInterval | undefined,
        groupBy: values["group-by"] as KpiGroupBy | undefined,
        timeField: values["time-field"] as KpiTimeField | undefined,
        from: values.from,
        to: values.to,
        platform: values.platform,
        eventType: values["event-type"],
        target: values.target,
      }),
    );
  });
}

async function dashboard(args: string[]): Promise<void> {
  const { values } = parseBrainFlags(args, DASHBOARD_FLAGS);
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

  if (values.json === true) {
    printJson(rendered.dashboard);
    return;
  }

  if (values.serve === true) {
    const host = values.host ?? "127.0.0.1";
    const port = values.port ?? 4738;
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

  const out = values.out ?? rendered.defaultOut;
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, rendered.artifact.html, "utf8");
  console.log(`brain: dashboard written ${out}`);
}

async function act(args: string[]): Promise<void> {
  const { values, positionals } = parseBrainFlags(args, ACT_FLAGS);
  const target = values.target ?? positionals[0];
  const message = values.message ?? positionals.slice(1).join(" ");
  if (!target) throw new Error("brain act requires --target <channel>");
  if (!message) throw new Error("brain act requires --message <text>");
  printJson(await brainAct({ target, message }));
}

async function hook(args: string[]): Promise<void> {
  const { values, positionals } = parseBrainFlags(args, HOOK_FLAGS);
  const lifecycle = positionals[0] ?? "SessionStart";
  const runner = (values.runner ?? "unknown") as Runner;
  printJson(await handleHook(lifecycle, runner));
}

function parseRidOrId(value: string): number | string {
  return /^\d+$/.test(value) ? Number(value) : value;
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

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
