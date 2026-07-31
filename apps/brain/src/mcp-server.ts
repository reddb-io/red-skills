#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { readBuildInfo, renderVersion } from "@reddb-io/build-info";
import { parseFlags, routeCommand, type FlagSchema } from "@reddb-io/shared/args.js";
import { withBrainRuntime } from "./runtime.js";
import { brainAct } from "./brain-act.js";
import { ARTIFACT_KINDS, CONNECTION_KINDS } from "./schema.js";

const CaptureInput = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  kind: z.enum(ARTIFACT_KINDS).default("note"),
  tags: z.array(z.string()).default([]),
  source_agent: z.string().optional(),
  source_session: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const SearchInput = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).default(10),
});

const GetInput = z.object({
  id: z.union([z.string(), z.number()]),
});

const LinkInput = z.object({
  from: z.union([z.string(), z.number()]),
  to: z.union([z.string(), z.number()]),
  kind: z.enum(CONNECTION_KINDS).default("related_to"),
  reason: z.string().optional(),
});

const ActInput = z.object({
  target: z.string().min(1),
  message: z.string().min(1),
});

const KpiInput = z.object({
  interval: z.enum(["hour", "day", "week", "month"]).default("day"),
  group_by: z.enum(["platform", "event_type", "target"]).optional(),
  time_field: z.enum(["event", "ingested"]).default("event"),
  from: z.union([z.string(), z.number()]).optional(),
  to: z.union([z.string(), z.number()]).optional(),
  platform: z.string().optional(),
  event_type: z.string().optional(),
  target: z.string().optional(),
});

const TOOLS = [
  {
    name: "brain_init",
    description: "Initialize the project Brain store and return resolved configuration.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "brain_status",
    description: "Return project Brain status.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "brain_capture",
    description: "Capture a durable artifact in the project Brain.",
    inputSchema: zodShape(CaptureInput),
  },
  {
    name: "brain_search",
    description: "Search Brain artifacts.",
    inputSchema: zodShape(SearchInput),
  },
  {
    name: "brain_think",
    description:
      "Return a deterministic cited synthesis over Brain search hits, including citations, confidence, and missing evidence.",
    inputSchema: zodShape(SearchInput),
  },
  {
    name: "brain_get",
    description: "Read a Brain artifact by rid or id.",
    inputSchema: zodShape(GetInput),
  },
  {
    name: "brain_link",
    description: "Create a typed connection between Brain artifacts.",
    inputSchema: zodShape(LinkInput),
  },
  {
    name: "brain_backlinks",
    description: "List incoming connections for a Brain artifact.",
    inputSchema: zodShape(GetInput),
  },
  {
    name: "brain_act",
    description:
      "Send a message to a channel target through the ChannelBridge, outbound-only (no gateway daemon; channel tokens only).",
    inputSchema: zodShape(ActInput),
  },
  {
    name: "brain_kpis",
    description:
      "Compute time-windowed KPI aggregations over kind:event artifacts (counts and per-window series), shaped for a dashboard. No metrics store; derived from the artifact graph.",
    inputSchema: zodShape(KpiInput),
  },
];

const buildInfo = readBuildInfo("brain-mcp");

async function main(): Promise<void> {
  const server = new Server(
    { name: "brain", version: buildInfo.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = req.params.arguments ?? {};
    switch (req.params.name) {
      case "brain_init":
      case "brain_status":
        return text(await withBrainRuntime(async ({ config, store }) => ({
          rootDir: config.rootDir,
          configPath: config.configPath,
          ...(await store.status()),
        })));
      case "brain_capture": {
        const input = CaptureInput.parse(args);
        return text(await withBrainRuntime(async ({ store }) => store.capture({
          title: input.title,
          content: input.content,
          kind: input.kind,
          tags: input.tags,
          sourceAgent: input.source_agent,
          sourceSession: input.source_session,
          sourcePath: process.cwd(),
          metadata: input.metadata,
        })));
      }
      case "brain_search": {
        const input = SearchInput.parse(args);
        return text(await withBrainRuntime(async ({ store }) => store.search(input.query, input.limit)));
      }
      case "brain_think": {
        const input = SearchInput.parse(args);
        const result = await withBrainRuntime(async ({ store }) => store.think(input.query, input.limit));
        return text(result.answer, result);
      }
      case "brain_get": {
        const input = GetInput.parse(args);
        return text(await withBrainRuntime(async ({ store }) => store.getArtifact(input.id)));
      }
      case "brain_link": {
        const input = LinkInput.parse(args);
        return text(await withBrainRuntime(async ({ store }) => store.link(input)));
      }
      case "brain_backlinks": {
        const input = GetInput.parse(args);
        return text(await withBrainRuntime(async ({ store }) => store.backlinks(input.id)));
      }
      case "brain_act": {
        const input = ActInput.parse(args);
        return text(await brainAct({ target: input.target, message: input.message }));
      }
      case "brain_kpis": {
        const input = KpiInput.parse(args);
        return text(await withBrainRuntime(async ({ store }) => store.eventKpis({
          interval: input.interval,
          groupBy: input.group_by,
          timeField: input.time_field,
          from: input.from,
          to: input.to,
          platform: input.platform,
          eventType: input.event_type,
          target: input.target,
        })));
      }
      default:
        throw new Error(`unknown Brain tool: ${req.params.name}`);
    }
  });

  await server.connect(new StdioServerTransport());
}

function text(content: unknown, structuredContent: unknown = content) {
  const rendered = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  return {
    content: [{ type: "text" as const, text: rendered }],
    structuredContent,
  };
}

function zodShape(_schema: z.ZodTypeAny): Record<string, unknown> {
  return { type: "object", additionalProperties: true };
}

/** The server's own flags — the same contract the `brain` CLI routes through. */
const MCP_BINARY_FLAGS = {
  version: { kind: "boolean", aliases: ["v"] },
  help: { kind: "boolean", aliases: ["h"] },
  json: { kind: "boolean" },
} satisfies FlagSchema;

/** Usage as a CONSTANT — the answer needs no store, no config and no stdio. */
const MCP_USAGE = `Usage: brain-mcp [command] [flags]

Commands:
  serve (default)  speak MCP over stdio against this project's Brain
  version          print the build stamp
  help             print this usage

Flags:
  -v, --version    print the build stamp (--json for the build info)
  -h, --help       print this usage
`;

const routedMcp = routeCommand<"serve" | "version" | "help">(process.argv.slice(2), {
  commands: { serve: {}, version: {}, help: {} },
  default: "serve",
});
const mcpFlags = parseFlags(routedMcp.args, MCP_BINARY_FLAGS).values;

// Answered before the store opens and before stdio is claimed: "which build is
// this?" and "what can it do?" are asked of a server that would not start, so
// neither may need one (#2878, #2918).
if (routedMcp.command === "help" || mcpFlags.help === true) {
  process.stdout.write(MCP_USAGE);
} else if (routedMcp.command === "version" || mcpFlags.version === true) {
  process.stdout.write(
    mcpFlags.json === true ? `${JSON.stringify(buildInfo)}\n` : `${renderVersion(buildInfo)}\n`,
  );
} else {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
