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
import { readConfig, resolveStoreUri } from "./config.js";
import { diagnose } from "./doctor.js";
import { neighbors, path, recall, search, traverse } from "./engine.js";
import { exportGraph } from "./export.js";
import { MemoryStore, factToNode } from "./graph-store.js";
import { HistoricalMemoryStore } from "./historical-memory-store.js";
import {
  executeReadOnlyMemoryOperation,
  listReadOnlyMemoryOperations,
  type ReadOnlyMemoryOperation,
} from "./operations.js";
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
    const operation = OPERATION_BY_TOOL_NAME.get(name);
    if (operation) {
      const output = await executeReadOnlyMemoryOperation(operation.id, { store }, args);
      return text(
        JSON.stringify(output, null, 2),
        await operationStructuredContent(operation.id, output, store),
      );
    }

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
            diagnostics: result.diagnostics,
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

const OPERATION_TOOLS = listReadOnlyMemoryOperations().map((operation) => ({
  name: operation.renderer.mcp.toolName,
  description: operation.renderer.mcp.description,
  inputSchema: zodToSchema(operation.inputSchema),
}));

const MANUAL_TOOLS = [
  {
    name: "memory_recall",
    description:
      "Hybrid recall: full-text seeds + graph-neighborhood expansion. Returns a markdown context block ready to inject, plus ranked nodes. Call BEFORE answering when a question depends on prior project knowledge. Zero-token (no LLM).",
    inputSchema: zodToSchema(RecallInput),
  },
  {
    name: "memory_store",
    description:
      "MUTATING: persist a durable fact (decision, problem, solution, why-note, ...) with optional typed relations to existing nodes. Idempotent by content hash.",
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
      "MUTATING: mark a node as superseded by a newer one. Recall hides the old node behind its successor by default.",
    inputSchema: zodToSchema(SupersedeInput),
  },
];

const TOOLS = [...OPERATION_TOOLS, ...MANUAL_TOOLS];

const OPERATION_BY_TOOL_NAME = new Map<string, ReadOnlyMemoryOperation>(
  listReadOnlyMemoryOperations().map((operation) => [
    operation.renderer.mcp.toolName,
    operation,
  ]),
);

async function operationStructuredContent(
  operationId: string,
  output: unknown,
  store: MemoryStore,
): Promise<Record<string, unknown>> {
  if (!isRecord(output)) return { operation_id: operationId };

  switch (operationId) {
    case "memory.ask": {
      const evidence = isRecord(output.evidence) ? output.evidence : {};
      const byConfidence = isRecord(evidence.byConfidence) ? evidence.byConfidence : {};
      return {
        operation_id: operationId,
        status: output.status,
        available: output.available,
        citations: arrayLength(output.citations),
        active_evidence: arrayLength(evidence.active),
        superseded_evidence: arrayLength(evidence.superseded),
        contradictions: arrayLength(evidence.contradictory),
        extracted_evidence: arrayLength(byConfidence.EXTRACTED),
        inferred_evidence: arrayLength(byConfidence.INFERRED),
        ambiguous_evidence: arrayLength(byConfidence.AMBIGUOUS),
        cost_usd: isRecord(output.cost) ? output.cost.cost_usd ?? null : null,
        prompt_tokens: isRecord(output.cost) ? output.cost.prompt_tokens ?? null : null,
        completion_tokens: isRecord(output.cost) ? output.cost.completion_tokens ?? null : null,
        model: isRecord(output.cost) ? output.cost.model ?? null : null,
        provider: isRecord(output.cost) ? output.cost.provider ?? null : null,
      };
    }
    case "memory.claim-check":
      return {
        operation_id: operationId,
        status: output.status,
        citations: arrayLength(output.citations),
        active_evidence: arrayLength(
          isRecord(output.evidence) ? output.evidence.active : undefined,
        ),
        conflicting_evidence: arrayLength(
          isRecord(output.evidence) ? output.evidence.conflicting : undefined,
        ),
      };
    case "memory.communities": {
      const stats = await store.stats();
      return {
        operation_id: operationId,
        communities: arrayLength(output.communities),
        assignments: arrayLength(output.assignments),
        graph_hash: output.graph_hash,
        cached: output.cached,
        nodes: stats.nodes,
        edges: stats.edges,
      };
    }
    case "memory.context-pack":
      return {
        operation_id: operationId,
        status: output.status,
        entries: arrayLength(output.entries),
        warnings: arrayLength(output.warnings),
        omitted_entries: output.omittedEntries,
      };
    case "memory.health":
      return {
        operation_id: operationId,
        state: output.state,
        stats: output.stats,
        stale: isRecord(output.stale) ? output.stale.stale : undefined,
      };
    case "memory.learning-debt":
      return {
        operation_id: operationId,
        status: output.status,
        summary: output.summary,
      };
    case "memory.lint":
      return {
        operation_id: operationId,
        status: output.status,
        findings: arrayLength(output.findings),
        total_memories: output.totalMemories,
        read_only: output.readOnly,
      };
    case "memory.privacy-scan":
      return {
        operation_id: operationId,
        status: output.status,
        findings: arrayLength(output.findings),
        total_memories: output.totalMemories,
        read_only: output.readOnly,
        mutated: output.mutated,
      };
    case "memory.provenance":
      return {
        operation_id: operationId,
        rid: isRecord(output.node) ? output.node.rid : undefined,
        label: isRecord(output.node) ? output.node.label : undefined,
        missing: isRecord(output.provenance) ? output.provenance.missing : undefined,
      };
    case "memory.readiness":
      return {
        operation_id: operationId,
        status: output.status,
        contract_version: isRecord(output.contract) ? output.contract.version : undefined,
        active_evidence: arrayLength(
          isRecord(output.evidence) ? output.evidence.active : undefined,
        ),
        next_actions: arrayLength(output.next_actions),
      };
    case "memory.skill-recommendations":
      return {
        operation_id: operationId,
        status: output.status,
        recommendations: arrayLength(output.recommendations),
        missing_evidence: arrayLength(output.missingEvidence),
      };
    default:
      return { operation_id: operationId };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

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
