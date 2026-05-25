#!/usr/bin/env node
/**
 * memory MCP server.
 *
 * Speaks MCP over stdio and exposes the recall/graph surface to agents. Wraps a
 * per-project embedded RedDB connection and the recall engine; recall/search/
 * traverse/path/neighbors are the zero-token read paths, `ask` is the one
 * LLM-backed verb.
 *
 * Store resolution (first match wins):
 *   RED_MEMORY_URI       — explicit RedDB URI (used by tests and advanced setups)
 *   MEMORY_ROOT / cwd    — read `.red/memory/config.json`; requires graph mode
 *
 *   RED_MEMORY_PROJECT   — project tag stamped on stored nodes (defaults to the
 *                          config's project or the root dir name)
 */

import { basename } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { buildCommunityAnalytics } from "./communities.js";
import { readConfig, resolveStoreUri } from "./config.js";
import { diagnose } from "./doctor.js";
import { ask, neighbors, path, recall, search, traverse } from "./engine.js";
import { exportGraph } from "./export.js";
import { MemoryStore, factToNode } from "./graph-store.js";
import { HistoricalMemoryStore } from "./historical-memory-store.js";
import type { EdgeLabel, MemoryScope, NodeType } from "./schema.js";
import { slugify } from "./store.js";
import { listContradictions, supersessionTimeline } from "./supersession.js";

// ---------- tool input schemas ----------

const NODE_TYPES = [
  "file",
  "symbol",
  "concept",
  "decision",
  "problem",
  "solution",
  "fix",
  "workflow",
  "person",
  "why_note",
  "session",
  "task",
  "goal",
] as const;

const MEMORY_SCOPES = [
  "user",
  "project",
  "repo",
  "branch",
  "worktree",
  "session",
  "agent-run",
] as const satisfies readonly MemoryScope[];

const RecallInput = z.object({
  query: z.string().min(1),
  k: z.number().int().min(1).max(50).default(8),
  depth: z.number().int().min(0).max(3).default(1),
  types: z.array(z.string()).optional(),
  as_of: z.string().optional(),
  scope: z.enum(MEMORY_SCOPES).optional(),
  scope_id: z.string().optional(),
  include_narrower_scopes: z.boolean().default(false),
});

const StoreInput = z.object({
  type: z.enum(NODE_TYPES).default("concept"),
  title: z.string().min(1),
  summary: z.string().optional(),
  content: z.string().optional(),
  tags: z.array(z.string()).default([]),
  importance: z.number().min(0).max(1).default(0.5),
  source: z.string().optional(),
  scope: z.enum(MEMORY_SCOPES).optional(),
  scope_id: z.string().optional(),
  relations: z
    .array(
      z.object({
        label: z.string(),
        target_label: z.string(),
        target_type: z.string().optional(),
      }),
    )
    .default([]),
});

const SearchInput = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(100).default(20),
});

const TraverseInput = z.object({
  start: z.string().min(1),
  depth: z.number().int().min(1).max(5).default(2),
  strategy: z.enum(["bfs", "dfs"]).default("bfs"),
  direction: z.enum(["outgoing", "incoming", "both"]).default("both"),
});

const NeighborsInput = z.object({
  label: z.string().min(1),
  depth: z.number().int().min(1).max(5).default(1),
  direction: z.enum(["outgoing", "incoming", "both"]).default("both"),
});

const PathInput = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  algorithm: z.enum(["bfs", "dijkstra"]).default("bfs"),
});

const AskInput = z.object({ question: z.string().min(1) });

const SupersedeInput = z.object({
  old_rid: z.number().int(),
  new_rid: z.number().int(),
  reason: z.string().optional(),
});

const ConflictsInput = z.object({
  include_resolved: z.boolean().default(false),
});

const TimelineInput = z.object({
  topic: z.string().min(1),
});

const ExportInput = z.object({
  /** When set, also writes graph.json + graph.html + audit.md into this dir. */
  out_dir: z.string().optional(),
});

const DoctorInput = z.object({
  stale_days: z.number().int().min(1).default(90),
});

const CommunitiesInput = z.object({
  use_cache: z.boolean().default(true),
});

// ---------- server ----------

async function main(): Promise<void> {
  const { uri, project } = await resolveStore();
  const store = await MemoryStore.open({ uri, project });

  const server = new Server(
    { name: "memory", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = req.params.arguments ?? {};

    switch (name) {
      case "memory_recall": {
        const input = RecallInput.parse(args);
        const recallStore = input.as_of
          ? await HistoricalMemoryStore.open({ uri, ref: input.as_of })
          : store;
        try {
          const result = await recall(recallStore, input.query, {
            k: input.k,
            depth: input.depth,
            types: input.types,
            now: input.as_of ? 0 : undefined,
            scope: input.scope
              ? {
                  level: input.scope,
                  id: input.scope_id,
                  includeNarrower: input.include_narrower_scopes,
                }
              : undefined,
          });
          return text(result.context_md, {
            nodes: result.nodes.map((n) => ({
              rid: n.rid,
              label: n.label,
              node_type: n.node_type,
              score: n.score,
              depth: n.depth,
              excerpt: n.excerpt,
            })),
          });
        } finally {
          if (input.as_of) await recallStore.close();
        }
      }
      case "memory_store": {
        const input = StoreInput.parse(args);
        const node = factToNode(input.title, slugify);
        node.node_type = input.type as NodeType;
        node.properties = {
          ...node.properties,
          title: input.title,
          summary: input.summary,
          content: input.content ?? input.summary ?? input.title,
          tags: input.tags,
          importance: input.importance,
          source: input.source ?? "mcp",
          scope: input.scope,
          scope_id: input.scope_id,
          confidence: "INFERRED",
        };
        const rid = await store.upsertNode(node);
        const edges: number[] = [];
        for (const rel of input.relations) {
          const target = await store.findNodeByLabel(rel.target_label);
          if (target == null) continue;
          edges.push(
            await store.upsertEdge({
              from_rid: rid,
              to_rid: target,
              label: rel.label as EdgeLabel,
            }),
          );
        }
        return text(`stored rid=${rid}, edges=${edges.length}`, { rid, edges });
      }
      case "memory_search": {
        const input = SearchInput.parse(args);
        const hits = await search(store, input.query, input.limit);
        return text(JSON.stringify(hits, null, 2), { count: hits.length });
      }
      case "memory_traverse": {
        const input = TraverseInput.parse(args);
        const rows = await traverse(store, input.start, {
          depth: input.depth,
          strategy: input.strategy,
          direction: input.direction,
        });
        return text(JSON.stringify(rows, null, 2), { count: rows.length });
      }
      case "memory_neighbors": {
        const input = NeighborsInput.parse(args);
        const rows = await neighbors(store, input.label, input.depth, input.direction);
        return text(JSON.stringify(rows, null, 2), { count: rows.length });
      }
      case "memory_path": {
        const input = PathInput.parse(args);
        const result = await path(store, input.from, input.to, input.algorithm);
        return text(JSON.stringify(result, null, 2), { reachable: result?.reachable ?? false });
      }
      case "memory_ask": {
        const input = AskInput.parse(args);
        const result = await ask(store, input.question);
        return text(JSON.stringify(result, null, 2), {
          status: result.status,
          available: result.available,
          citations: result.citations.length,
          active_evidence: result.evidence.active.length,
          superseded_evidence: result.evidence.superseded.length,
          contradictions: result.evidence.contradictory.length,
          extracted_evidence: result.evidence.byConfidence.EXTRACTED.length,
          inferred_evidence: result.evidence.byConfidence.INFERRED.length,
          ambiguous_evidence: result.evidence.byConfidence.AMBIGUOUS.length,
          cost_usd: result.cost?.cost_usd ?? null,
          prompt_tokens: result.cost?.prompt_tokens ?? null,
          completion_tokens: result.cost?.completion_tokens ?? null,
          model: result.cost?.model ?? null,
          provider: result.cost?.provider ?? null,
        });
      }
      case "memory_export": {
        const input = ExportInput.parse(args);
        if (input.out_dir) {
          const result = await exportGraph(store, input.out_dir);
          return text(JSON.stringify(result, null, 2), {
            nodes: result.nodes,
            edges: result.edges,
          });
        }
        const [nodes, edges, stats] = await Promise.all([
          store.listNodes(),
          store.listEdges(),
          store.stats(),
        ]);
        return text(JSON.stringify({ nodes, edges, stats }, null, 2), stats);
      }
      case "memory_doctor": {
        const input = DoctorInput.parse(args);
        const report = await diagnose(store, { staleDays: input.stale_days });
        return text(JSON.stringify(report, null, 2), {
          total: report.totalNodes,
          stale: report.stale.length,
        });
      }
      case "memory_stats": {
        const stats = await store.stats();
        return text(JSON.stringify(stats, null, 2), stats);
      }
      case "memory_communities": {
        const input = CommunitiesInput.parse(args);
        const [report, stats] = await Promise.all([
          buildCommunityAnalytics(store, { cache: input.use_cache ? "read-only" : "off" }),
          store.stats(),
        ]);
        return text(JSON.stringify(report, null, 2), {
          communities: report.communities.length,
          assignments: report.assignments.length,
          graph_hash: report.graph_hash,
          cached: report.cached,
          nodes: stats.nodes,
          edges: stats.edges,
        });
      }
      case "memory_conflicts": {
        const input = ConflictsInput.parse(args);
        const conflicts = await listContradictions(store, {
          includeResolved: input.include_resolved,
        });
        return text(JSON.stringify(conflicts, null, 2), { count: conflicts.length });
      }
      case "memory_timeline": {
        const input = TimelineInput.parse(args);
        const timeline = await supersessionTimeline(store, input.topic);
        return text(JSON.stringify(timeline, null, 2), {
          entries: timeline.entries.length,
          audit_links: timeline.auditLinks.length,
        });
      }
      case "memory_supersede": {
        const input = SupersedeInput.parse(args);
        const edgeRid = await store.supersede(input.old_rid, input.new_rid, input.reason);
        return text(`superseded ${input.old_rid} -> ${input.new_rid}`, {
          edge_rid: edgeRid,
        });
      }
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    try {
      await store.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/** Resolve which RedDB store the server speaks to, and the project tag. */
async function resolveStore(): Promise<{ uri: string; project: string }> {
  if (process.env.RED_MEMORY_URI) {
    return {
      uri: process.env.RED_MEMORY_URI,
      project: process.env.RED_MEMORY_PROJECT ?? basename(process.cwd()),
    };
  }
  const root = process.env.MEMORY_ROOT ?? process.cwd();
  const config = await readConfig(root);
  if (!config) {
    throw new Error(
      `memory is not initialized at ${root} — run \`memory init --mode graph\` first (or set RED_MEMORY_URI)`,
    );
  }
  if (config.mode !== "graph") {
    throw new Error(
      `the MCP server needs graph mode — ${root} is "${config.mode}". Re-run \`memory init --mode graph\``,
    );
  }
  return {
    uri: resolveStoreUri(root, config),
    project: process.env.RED_MEMORY_PROJECT ?? basename(root),
  };
}

function text(body: string, structured?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: body }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

const TOOLS = [
  {
    name: "memory_recall",
    description:
      "Hybrid recall: full-text seeds + graph-neighborhood expansion. Returns a markdown context block ready to inject, plus ranked nodes. Call BEFORE answering when a question depends on prior project knowledge. Zero-token (no LLM).",
    inputSchema: zodToSchema(RecallInput),
  },
  {
    name: "memory_store",
    description:
      "Persist a durable fact (decision, problem, solution, why-note, ...) with optional typed relations to existing nodes. Idempotent by content hash.",
    inputSchema: zodToSchema(StoreInput),
  },
  {
    name: "memory_search",
    description: "Direct full-text search over node titles and content.",
    inputSchema: zodToSchema(SearchInput),
  },
  {
    name: "memory_traverse",
    description: "BFS/DFS graph traversal from a node label.",
    inputSchema: zodToSchema(TraverseInput),
  },
  {
    name: "memory_neighbors",
    description: "Immediate (or N-hop) neighbors of a node label.",
    inputSchema: zodToSchema(NeighborsInput),
  },
  {
    name: "memory_path",
    description: "Shortest path between two nodes by label (bfs or dijkstra).",
    inputSchema: zodToSchema(PathInput),
  },
  {
    name: "memory_ask",
    description:
      "Grounded ASK over the memory document collection (RedDB ASK with citations and per-call cost). Requires an LLM key on the engine; degrades gracefully when absent.",
    inputSchema: zodToSchema(AskInput),
  },
  {
    name: "memory_export",
    description:
      "Dump the whole graph (nodes, edges, stats) as JSON. Pass `out_dir` to also write a navigable graph.html + graph.json + audit.md bundle there.",
    inputSchema: zodToSchema(ExportInput),
  },
  {
    name: "memory_doctor",
    description:
      "Inspect graph health: list stale nodes (unaccessed `stale_days`+ days AND never recalled; pinned nodes exempt). Read-only — pruning is a confirmed CLI operation.",
    inputSchema: zodToSchema(DoctorInput),
  },
  {
    name: "memory_stats",
    description: "Counts of nodes/edges and basic store health.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "memory_communities",
    description:
      "Read-only Memory graph community analytics: native Louvain assignments, community counts, top labels/titles, and graph-hash cache metadata. Does not write derived clusters into Memory graph evidence.",
    inputSchema: zodToSchema(CommunitiesInput),
  },
  {
    name: "memory_conflicts",
    description:
      "Read-only contradiction inspection. Lists CONTRADICTS edges that have not converged on the same active supersession head; pass include_resolved to audit resolved conflicts too.",
    inputSchema: zodToSchema(ConflictsInput),
  },
  {
    name: "memory_timeline",
    description:
      "Read-only topic timeline. Shows active and superseded guidance plus contradiction/supersession audit links for matching memory nodes.",
    inputSchema: zodToSchema(TimelineInput),
  },
  {
    name: "memory_supersede",
    description:
      "Mark a node as superseded by a newer one. Recall hides the old node behind its successor by default.",
    inputSchema: zodToSchema(SupersedeInput),
  },
];

function zodToSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  // Minimal conversion — MCP only requires shape hints, not a full JSON Schema.
  const shape = (
    schema as unknown as { _def: { shape?: () => Record<string, z.ZodTypeAny> } }
  )._def.shape?.();
  if (!shape) return { type: "object", additionalProperties: true };
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(shape)) {
    properties[key] = describe(value);
    if (!value.isOptional()) required.push(key);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

function describe(v: z.ZodTypeAny): Record<string, unknown> {
  const def = (v as unknown as { _def: { typeName?: string; innerType?: z.ZodTypeAny } })
    ._def;
  if (def.typeName === "ZodOptional" || def.typeName === "ZodDefault") {
    if (def.innerType) return describe(def.innerType);
  }
  if (def.typeName === "ZodString") return { type: "string" };
  if (def.typeName === "ZodNumber") return { type: "number" };
  if (def.typeName === "ZodBoolean") return { type: "boolean" };
  if (def.typeName === "ZodArray") return { type: "array" };
  if (def.typeName === "ZodEnum") {
    return { type: "string", enum: (v as unknown as { options: string[] }).options };
  }
  return {};
}

main().catch((err) => {
  console.error("[memory-mcp] fatal:", err);
  process.exit(1);
});
