/**
 * The memory tool BODY: what each `memory_*` tool does, and against which store.
 *
 * This file used to be the whole MCP server — it resolved a root, opened a
 * RedDB, published the schemas and served stdio, once per session. ADR 0152
 * split that: the daemon holds one store per Project and runs the body below,
 * while `rs_memory` publishes the surface and forwards (ADR 0147 rule 2).
 *
 * So there is deliberately NO argv, NO stdio and NO process lifecycle here. A
 * module the daemon imports may not claim a terminal or read a command line;
 * everything this file does, it does to a store it was handed.
 */
import { basename } from "node:path";
import { z } from "zod";
import { type MemoryConfig, readConfig, resolveStoreUri } from "../config.js";
import { diagnose } from "../doctor.js";
import { runAutoCure } from "../auto-curation.js";
import { neighbors, path, recall, search, traverse } from "../engine.js";
import { resolveProvider } from "../extract-conversation.js";
import { exportGraph, toEdge } from "../export.js";
import {
  memoryStoreEvidence,
  type GovernedWriteResult,
} from "../governed-write.js";
import { buildGraphContract } from "../graph-contract.js";
import { MemoryStore, factToNode } from "../graph-store.js";
import { HistoricalMemoryStore } from "../historical-memory-store.js";
import {
  executeReadOnlyMemoryOperation,
  listReadOnlyMemoryOperations,
  type ReadOnlyMemoryOperation,
} from "../operations.js";
import { runPromote } from "../promote.js";
import type { Confidence, EdgeLabel, MemoryScope, NodeType } from "../schema.js";
import {
  current as sessionCurrent,
  end as sessionEnd,
  start as sessionStart,
} from "../session-manager.js";
import { slugify } from "../store.js";
import { renderToonDocument } from "../toon-output.js";
import { listContradictions, supersessionTimeline } from "../supersession.js";
import {
  appendEvent as workingAppendEvent,
  listEvents as workingListEvents,
} from "../working-memory.js";
import { applyProviderEnv } from "../provider-client.js";
import { listMemoryOperationsForTransport } from "../operation-transport-adapter.js";
import { operationStructuredContent } from "./structured-content.js";

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

const StoreEvidenceInput = z.object({
  claim: z.string().optional(),
  source_ref: z.string().optional(),
  citation_excerpt: z.string().optional(),
  intent: z.string().optional(),
  observer: z.string().optional(),
  blast_radius: z.string().optional(),
  confidence: z.enum(["EXTRACTED", "INFERRED", "AMBIGUOUS"]).optional(),
  route: z.string().optional(),
  proposal_kind: z.string().optional(),
  proposal_id: z.string().optional(),
  proposal_path: z.string().optional(),
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

const AutocureInput = z.object({
  apply: z.boolean().default(false),
  stale_days: z.number().int().min(1).optional(),
});

const SessionStartInput = z.object({
  id: z.string().min(1).optional(),
});

const SessionEndInput = z.object({}).strict();

const WorkingGetInput = z.object({
  type: z.string().min(1).optional(),
});

const WorkingSetInput = z.object({
  type: z.string().min(1),
  value: z.string(),
});

const PromoteInput = z.object({
  triggered_by: z.enum(["explicit", "hook", "overflow"]).default("explicit"),
  session_id: z.string().min(1).optional(),
});

const NO_ACTIVE_SESSION_ERROR =
  "no active memory session — call memory_session_start first (or rely on the SessionStart hook to mint one)";

async function requireActiveSession(rootDir: string): Promise<string> {
  const id = await sessionCurrent(rootDir);
  if (!id) throw new Error(NO_ACTIVE_SESSION_ERROR);
  return id;
}

// ---------- server ----------

/** The store one dispatch runs against, and the Project context around it. */
export interface MemoryToolContext {
  /** The open graph store the daemon holds for this Project. */
  readonly store: MemoryStore;
  /** Its RedDB URI — reopened read-only when a call asks `as_of` a git ref. */
  readonly uri: string;
  /** The store ROOT: where sessions, evidence artifacts and notes are written. */
  readonly root: string;
  /** The resolved memory config, when the root carries one. */
  readonly config?: MemoryConfig | undefined;
}

/** What one tool call answers with, in the shape MCP renders. */
export interface MemoryToolResult {
  readonly content: Array<{ type: "text"; text: string }>;
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
}

/** Every tool the memory surface publishes, core and generated alike. */
export function memoryToolDescriptors(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  return TOOLS.map((tool) => ({ ...tool }));
}

/**
 * Serve one memory tool against one store.
 *
 * Errors are RETURNED rather than thrown, as `isError` results, because that is
 * what an MCP caller can act on: a tool that rejects with a transport error
 * tells the model the server broke, while a tool result naming the bad argument
 * tells it what to send instead. The daemon forwards this shape unchanged.
 */
export async function serveMemoryTool(
  context: MemoryToolContext,
  name: string,
  args: Readonly<Record<string, unknown>> = {},
): Promise<MemoryToolResult> {
  const { store, uri, root, config } = context;
    try {
      const operation = OPERATION_BY_TOOL_NAME.get(name);
      if (operation) {
        const output = await executeReadOnlyMemoryOperation(
          operation.id,
          { store, rootDir: root, providerConfig: config?.provider, transportSurface: "mcp" },
          args,
        );
        return text(output, await operationStructuredContent(operation.id, output, store));
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
          const nodes = result.nodes.map((n) => {
            const hooks = extractMcpHookEntries(n.properties.hooks);
            return {
              rid: n.rid,
              label: n.label,
              node_type: n.node_type,
              score: n.score,
              depth: n.depth,
              excerpt: n.excerpt,
              ...(hooks ? { hooks } : {}),
            };
          });
          return text(
            {
              nodes,
              diagnostics: result.diagnostics,
              summary: {
                query: result.query,
                nodes: nodes.length,
                format: "toon",
              },
            },
            {
              nodes,
              diagnostics: result.diagnostics,
            },
          );
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
        return text({ status: "stored", rid, edges: edges.length }, { rid, edges });
      }
      case "memory_store_evidence": {
        const input = StoreEvidenceInput.parse(args);
        const result = await memoryStoreEvidence(
          store,
          {
            claim: input.claim,
            sourceRef: input.source_ref,
            citationExcerpt: input.citation_excerpt,
            intent: input.intent,
            observer: input.observer,
            blastRadius: input.blast_radius,
            confidence: input.confidence as Confidence | undefined,
            route: input.route,
            proposalKind: input.proposal_kind,
            proposalId: input.proposal_id,
            proposalPath: input.proposal_path,
          },
          { rootDir: root },
        );
        return text(result, governedWriteStructuredContent(result));
      }
      case "memory_search": {
        const input = SearchInput.parse(args);
        const hits = await search(store, input.query, input.limit);
        return text({ hits: compactRecalledNodes(hits) }, { count: hits.length });
      }
      case "memory_traverse": {
        const input = TraverseInput.parse(args);
        const rows = await traverse(store, input.start, {
          depth: input.depth,
          strategy: input.strategy,
          direction: input.direction,
        });
        return text({ rows: compactRecalledNodes(rows) }, { count: rows.length });
      }
      case "memory_neighbors": {
        const input = NeighborsInput.parse(args);
        const rows = await neighbors(store, input.label, input.depth, input.direction);
        return text({ rows: compactRecalledNodes(rows) }, { count: rows.length });
      }
      case "memory_path": {
        const input = PathInput.parse(args);
        const result = await path(store, input.from, input.to, input.algorithm);
        return text({ result }, { reachable: result?.reachable ?? false });
      }
      case "memory_export": {
        const input = ExportInput.parse(args);
        if (input.out_dir) {
          const result = await exportGraph(store, input.out_dir);
          return text(result, {
            nodes: result.nodes,
            edges: result.edges,
          });
        }
        const [nodes, edges, stats] = await Promise.all([
          store.listNodes(),
          store.listEdges(),
          store.stats(),
        ]);
        const contract = buildGraphContract({ nodes, edges: edges.map(toEdge) });
        return text({ contract, nodes, edges, stats }, stats);
      }
      case "memory_doctor": {
        const input = DoctorInput.parse(args);
        const report = await diagnose(store, { staleDays: input.stale_days });
        return text(report, {
          total: report.totalNodes,
          stale: report.stale.length,
        });
      }
      case "memory_stats": {
        const stats = await store.stats();
        return text(stats, stats);
      }
      case "memory_conflicts": {
        const input = ConflictsInput.parse(args);
        const conflicts = await listContradictions(store, {
          includeResolved: input.include_resolved,
        });
        return text({ conflicts }, { count: conflicts.length });
      }
      case "memory_timeline": {
        const input = TimelineInput.parse(args);
        const timeline = await supersessionTimeline(store, input.topic);
        return text(timeline, {
          entries: timeline.entries.length,
          audit_links: timeline.auditLinks.length,
        });
      }
      case "memory_supersede": {
        const input = SupersedeInput.parse(args);
        const edgeRid = await store.supersede(input.old_rid, input.new_rid, input.reason);
        return text({
          status: "superseded",
          old_rid: input.old_rid,
          new_rid: input.new_rid,
          edge_rid: edgeRid,
        }, {
          edge_rid: edgeRid,
        });
      }
      case "memory_autocure": {
        const input = AutocureInput.parse(args);
        const report = await runAutoCure(store, {
          apply: input.apply,
          staleDays: input.stale_days,
        });
        return text(report, {
          dry_run: report.dry_run,
          proposed: report.actions_proposed.length,
          applied: report.actions_applied.length,
          skipped_claim_guarded: report.skipped_claim_guarded.length,
          entropy_before: report.entropy_before,
          entropy_after: report.entropy_after,
        });
      }
      case "memory_session_start": {
        const input = SessionStartInput.parse(args);
        const id = await sessionStart(root, input.id ? { id: input.id } : {});
        return text({ status: "session_started", session_id: id }, { session_id: id });
      }
      case "memory_session_end": {
        SessionEndInput.parse(args);
        await sessionEnd(root);
        return text({ status: "session_ended", ok: true }, { ok: true });
      }
      case "memory_working_get": {
        const input = WorkingGetInput.parse(args);
        await requireActiveSession(root);
        const events = await workingListEvents(
          store,
          root,
          input.type ? { type: input.type } : {},
        );
        return text({ events }, {
          count: events.length,
        });
      }
      case "memory_working_set": {
        const input = WorkingSetInput.parse(args);
        await requireActiveSession(root);
        const event = await workingAppendEvent(store, root, {
          type: input.type,
          value: input.value,
        });
        return text(event, {
          rid: event.rid,
          session_id: event.session_id,
          sequence: event.sequence,
          type: event.type,
        });
      }
      case "memory_promote": {
        const input = PromoteInput.parse(args);
        const sessionId = input.session_id ?? (await requireActiveSession(root));
        const report = await runPromote(store, root, {
          triggeredBy: input.triggered_by,
          sessionId,
        });
        return text(report, {
          session_id: report.session_id,
          promoted: report.promoted,
          reinforced: report.reinforced,
          skipped: report.skipped,
        });
      }
      default:
        throw new Error(`unknown tool: ${name}`);
    }
    } catch (error) {
      return toolError(name, error);
    }
}


/**
 * Resolve which RedDB store answers for one memory ROOT, and the project tag.
 *
 * The root is an ARGUMENT rather than an ambient read, because the daemon holds
 * one store per Project and stands in none of them (ADR 0152): a resolver that
 * reached for `process.cwd()` would answer for whichever directory the daemon
 * happened to be started in, for every Project on the host.
 */
export async function resolveMemoryStoreTarget(root: string): Promise<{
  uri: string;
  project: string;
  root: string;
  config?: MemoryConfig;
}> {
  const config = await readConfig(root);
  if (!config) {
    throw new Error(
      `memory is not initialized at ${root} — run \`memory init --mode graph\` first`,
    );
  }
  if (config.mode !== "graph") {
    throw new Error(
      `the memory tool surface needs graph mode — ${root} is "${config.mode}". Re-run \`memory init --mode graph\``,
    );
  }
  applyConfiguredProviderEnv(config.provider);
  return {
    uri: resolveStoreUri(root, config),
    project: basename(root),
    root,
    config,
  };
}

/** Open the store one memory root names, ready for {@link serveMemoryTool}. */
export async function openMemoryToolContext(root: string): Promise<MemoryToolContext> {
  const target = await resolveMemoryStoreTarget(root);
  return {
    store: await MemoryStore.open({ uri: target.uri, project: target.project }),
    uri: target.uri,
    root: target.root,
    ...(target.config == null ? {} : { config: target.config }),
  };
}

function applyConfiguredProviderEnv(provider: MemoryConfig["provider"]): void {
  if (!provider) return;
  try {
    applyProviderEnv(resolveProvider(provider), provider.apiKeyEnv);
  } catch {
    // Keep deterministic MCP read surfaces available; provider-aware tools
    // surface invalid provider config in their own result payload.
  }
}

function text(body: unknown, structured?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: renderToonDocument(body) }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

function toolError(tool: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const payload = {
    error: {
      tool,
      message,
      next: "check the tool arguments and retry with values matching the input schema",
    },
  };
  return {
    ...text(payload, payload.error),
    isError: true,
  };
}

function compactRecalledNodes(nodes: Array<{
  rid: number;
  label: string;
  node_type: string;
  score: number;
  depth?: number;
  excerpt: string;
}>) {
  return nodes.map((node) => ({
    rid: node.rid,
    label: node.label,
    node_type: node.node_type,
    score: node.score,
    depth: node.depth,
    excerpt: node.excerpt,
  }));
}

const MCP_OPERATIONS = listMemoryOperationsForTransport(listReadOnlyMemoryOperations(), "mcp");

const OPERATION_TOOLS = MCP_OPERATIONS.map((operation) => ({
  name: operation.renderer.mcp.toolName,
  description: operation.description,
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
    name: "memory_store_evidence",
    description:
      "MUTATING governed write: submit operational evidence through the shared Memory write policy. Returns stored, proposed, or rejected depending on governance review requirements.",
    inputSchema: zodToSchema(StoreEvidenceInput),
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
  {
    name: "memory_session_start",
    description:
      "MUTATING: mint and write a new memory session id to `.red/memory/sessions/current` (overwriting any existing id). Pass `id` to reuse a runner-supplied session id; otherwise a UUID is minted. Working-memory (L2) reads/writes and promotion all scope to this session id.",
    inputSchema: zodToSchema(SessionStartInput),
  },
  {
    name: "memory_session_end",
    description:
      "MUTATING: drop `.red/memory/sessions/current`. After this, working-memory and promotion verbs will error until `memory_session_start` (or a SessionStart hook) mints a new id.",
    inputSchema: zodToSchema(SessionEndInput),
  },
  {
    name: "memory_working_get",
    description:
      "Read typed L2 working-memory events for the current session, oldest first. Optional `type` filter (e.g. `decision_candidate`, `tool_call`). Requires an active session.",
    inputSchema: zodToSchema(WorkingGetInput),
  },
  {
    name: "memory_working_set",
    description:
      "MUTATING: append a typed event to the current session's L2 working-memory stream. `type` is the event tag, `value` is the verbatim text. Crossing the L2 overflow threshold may trigger a promotion pass as a backstop. Requires an active session.",
    inputSchema: zodToSchema(WorkingSetInput),
  },
  {
    name: "memory_promote",
    description:
      "MUTATING: run the PromotionEngine for the current session against L3 — promotes new typed L2 events into durable nodes and reinforces matched existing ones. Returns `(promoted, reinforced, skipped)` plus rids and decisions. Requires an active session unless `session_id` is supplied.",
    inputSchema: zodToSchema(PromoteInput),
  },
  {
    name: "memory_autocure",
    description:
      "Opt-in auto-curation orchestrator (memory.autocure.v1). Default is dry-run: returns proposed actions and entropy_before/entropy_after with no mutation. Pass apply=true to execute proposals; claim-guarded nodes (properties.claim_guard === true) are never mutated and surface in skipped_claim_guarded.",
    inputSchema: zodToSchema(AutocureInput),
  },
];

const TOOLS = [...OPERATION_TOOLS, ...MANUAL_TOOLS];

const OPERATION_BY_TOOL_NAME = new Map<string, ReadOnlyMemoryOperation>(
  MCP_OPERATIONS.map((operation) => [
    operation.renderer.mcp.toolName,
    operation,
  ]),
);

function governedWriteStructuredContent(
  result: GovernedWriteResult,
): Record<string, unknown> {
  const artifactId =
    result.review_artifact?.id ??
    result.memory.urn ??
    (result.memory.id == null ? null : String(result.memory.id));
  return {
    operation: result.operation,
    schema_version: result.schema_version,
    outcome: result.outcome,
    reason: result.reason,
    policy_reason: result.policy.reason,
    policy: result.policy,
    artifact_id: artifactId,
    artifact_path: result.review_artifact?.path ?? null,
    provenance: result.provenance,
    memory_id: result.memory.id,
    memory_urn: result.memory.urn,
    review_artifact_id: result.review_artifact?.id ?? null,
    review_artifact_path: result.review_artifact?.path ?? null,
  };
}


function extractMcpHookEntries(
  raw: unknown,
): Array<{ lifecycle: string; command: string; exit_code: number }> | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: Array<{ lifecycle: string; command: string; exit_code: number }> = [];
  for (const item of raw) {
    if (item == null || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const lifecycle = typeof entry.lifecycle === "string" ? entry.lifecycle : "";
    const command = typeof entry.command === "string" ? entry.command : "";
    const exit = entry.exit_code;
    const exit_code =
      typeof exit === "number" && Number.isFinite(exit)
        ? exit
        : typeof exit === "string" && /^-?\d+$/.test(exit.trim())
          ? Number(exit.trim())
          : NaN;
    if (!lifecycle || !command || !Number.isFinite(exit_code)) continue;
    out.push({ lifecycle, command, exit_code });
  }
  return out.length > 0 ? out : null;
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
