// The `rs_memory` tool surface: schemas, and the daemon method behind them.
//
// The schemas live HERE, in the adapter, so MCP discovery costs no round trip —
// a host that mounts `rs_memory` can list the core surface before the daemon
// has been reached at all. What it may NOT hold is anything that answers one:
// no RedDB, no graph store, no root resolution, no config read. Every call is
// forwarded whole to the daemon, which holds one store per Project (ADR 0152).
//
// **This is the CORE, not the whole surface.** Memory's read-only operations
// register their own `memory_*` tools from a registry that lives with the
// engine, so only the daemon can enumerate them; `memory_tools` is the one call
// that asks. Declaring them here would mean shipping the engine's registry in
// every session, which is the cost ADR 0147 rule 2 removed.
//
// The published names are the ones the memory MCP has always published. A
// rename here would be a rename of every skill and habit built on them, which
// is a different decision from moving where the store lives.
import { z } from "zod/v3";
import { REDSKILLS_ACP_METHODS } from "@reddb-io/protocol-acp";

/** The published name of the memory plugin's own MCP (ADR 0147 rule 2). */
export const RS_MEMORY_MCP_SERVER_NAME = "rs_memory";

/** The daemon method every tool forwards to. Named from the shared registry. */
export const RS_MEMORY_CALL_METHOD = REDSKILLS_ACP_METHODS.memoryCall;

/** The tool that asks the daemon for the rest of the surface. */
export const RS_MEMORY_SURFACE_TOOL = "memory_tools";

/** One published tool, in the shape MCP lists it. */
export interface RsMemoryTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

const NODE_TYPES = [
  "file", "symbol", "concept", "decision", "problem", "solution", "fix",
  "workflow", "person", "why_note", "session", "task", "goal",
] as const;

const MEMORY_SCOPES = [
  "user", "project", "repo", "branch", "worktree", "session", "agent-run",
] as const;

const CONFIDENCE = ["OBSERVED", "EXTRACTED", "INFERRED", "ASSERTED"] as const;

/**
 * The core surface, declared once.
 *
 * Written as zod and rendered to JSON Schema below, rather than as hand-written
 * JSON Schema, because a shape and its description drift apart the moment they
 * are two literals — and the daemon re-validates every argument anyway, so what
 * the adapter publishes is a HINT for the model, never the gate.
 */
const CORE_TOOL_SHAPES: ReadonlyArray<{
  readonly name: string;
  readonly description: string;
  readonly input: z.ZodObject<z.ZodRawShape>;
}> = [
  {
    name: RS_MEMORY_SURFACE_TOOL,
    description:
      "List every memory tool this Project's store publishes, including the read-only " +
      "operation tools the daemon registers beyond this core surface.",
    input: z.object({}),
  },
  {
    name: "memory_recall",
    description:
      "Hybrid recall: full-text seeds + graph-neighborhood expansion. Returns a markdown context " +
      "block ready to inject, plus ranked nodes. Call BEFORE answering when a question depends on " +
      "prior project knowledge. Zero-token (no LLM).",
    input: z.object({
      query: z.string().min(1),
      k: z.number().int().min(1).max(50).optional(),
      depth: z.number().int().min(0).max(3).optional(),
      types: z.array(z.string()).optional(),
      as_of: z.string().optional(),
      scope: z.enum(MEMORY_SCOPES).optional(),
      scope_id: z.string().optional(),
      include_narrower_scopes: z.boolean().optional(),
    }),
  },
  {
    name: "memory_store",
    description:
      "MUTATING: persist a durable fact (decision, problem, solution, why-note, ...) with optional " +
      "typed relations to existing nodes. Idempotent by content hash.",
    input: z.object({
      type: z.enum(NODE_TYPES).optional(),
      title: z.string().min(1),
      summary: z.string().optional(),
      content: z.string().optional(),
      tags: z.array(z.string()).optional(),
      importance: z.number().min(0).max(1).optional(),
      source: z.string().optional(),
      scope: z.enum(MEMORY_SCOPES).optional(),
      scope_id: z.string().optional(),
      relations: z.array(z.object({
        label: z.string(),
        target_label: z.string(),
        target_type: z.string().optional(),
      })).optional(),
    }),
  },
  {
    name: "memory_store_evidence",
    description:
      "MUTATING governed write: submit operational evidence through the shared Memory write policy. " +
      "Returns stored, proposed, or rejected depending on governance review requirements.",
    input: z.object({
      claim: z.string().min(1),
      source_ref: z.string().optional(),
      citation_excerpt: z.string().optional(),
      intent: z.string().optional(),
      observer: z.string().optional(),
      blast_radius: z.string().optional(),
      confidence: z.enum(CONFIDENCE).optional(),
      route: z.string().optional(),
      proposal_kind: z.string().optional(),
      proposal_id: z.string().optional(),
      proposal_path: z.string().optional(),
    }),
  },
  {
    name: "memory_search",
    description: "Direct full-text search over node titles and content.",
    input: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(50).optional() }),
  },
  {
    name: "memory_traverse",
    description: "BFS/DFS graph traversal from a node label.",
    input: z.object({
      start: z.string().min(1),
      depth: z.number().int().min(1).max(5).optional(),
      strategy: z.enum(["bfs", "dfs"]).optional(),
      direction: z.enum(["out", "in", "both"]).optional(),
    }),
  },
  {
    name: "memory_neighbors",
    description: "Immediate (or N-hop) neighbors of a node label.",
    input: z.object({
      label: z.string().min(1),
      depth: z.number().int().min(1).max(5).optional(),
      direction: z.enum(["out", "in", "both"]).optional(),
    }),
  },
  {
    name: "memory_path",
    description: "Shortest path between two nodes by label (bfs or dijkstra).",
    input: z.object({
      from: z.string().min(1),
      to: z.string().min(1),
      algorithm: z.enum(["bfs", "dijkstra"]).optional(),
    }),
  },
  {
    name: "memory_export",
    description:
      "Dump the whole graph (nodes, edges, stats) as JSON. Pass `out_dir` to also write a navigable " +
      "graph.html + graph.json + audit.md bundle there.",
    input: z.object({ out_dir: z.string().optional() }),
  },
  {
    name: "memory_doctor",
    description:
      "Inspect graph health: list stale nodes (unaccessed `stale_days`+ days AND never recalled; " +
      "pinned nodes exempt). Read-only — pruning is a confirmed CLI operation.",
    input: z.object({ stale_days: z.number().int().min(1).optional() }),
  },
  {
    name: "memory_stats",
    description: "Counts of nodes/edges and basic store health.",
    input: z.object({}),
  },
  {
    name: "memory_conflicts",
    description:
      "Read-only contradiction inspection. Lists CONTRADICTS edges that have not converged on the " +
      "same active supersession head; pass include_resolved to audit resolved conflicts too.",
    input: z.object({ include_resolved: z.boolean().optional() }),
  },
  {
    name: "memory_timeline",
    description:
      "Read-only topic timeline. Shows active and superseded guidance plus contradiction/supersession " +
      "audit links for matching memory nodes.",
    input: z.object({ topic: z.string().min(1) }),
  },
  {
    name: "memory_supersede",
    description:
      "MUTATING: mark a node as superseded by a newer one. Recall hides the old node behind its " +
      "successor by default.",
    input: z.object({
      old_rid: z.number().int(),
      new_rid: z.number().int(),
      reason: z.string().optional(),
    }),
  },
  {
    name: "memory_session_start",
    description:
      "MUTATING: mint and write a new memory session id (overwriting any existing id). Pass `id` to " +
      "reuse a runner-supplied session id; otherwise a UUID is minted. Working-memory (L2) " +
      "reads/writes and promotion all scope to this session id.",
    input: z.object({ id: z.string().min(1).optional() }),
  },
  {
    name: "memory_session_end",
    description:
      "MUTATING: drop the current memory session. After this, working-memory and promotion verbs " +
      "will error until `memory_session_start` (or a SessionStart hook) mints a new id.",
    input: z.object({}),
  },
  {
    name: "memory_working_get",
    description:
      "Read typed L2 working-memory events for the current session, oldest first. Optional `type` " +
      "filter (e.g. `decision_candidate`, `tool_call`). Requires an active session.",
    input: z.object({ type: z.string().min(1).optional() }),
  },
  {
    name: "memory_working_set",
    description:
      "MUTATING: append a typed event to the current session's L2 working-memory stream. `type` is " +
      "the event tag, `value` is the verbatim text. Crossing the L2 overflow threshold may trigger a " +
      "promotion pass as a backstop. Requires an active session.",
    input: z.object({ type: z.string().min(1), value: z.string() }),
  },
  {
    name: "memory_promote",
    description:
      "MUTATING: run the PromotionEngine for the current session against L3 — promotes new typed L2 " +
      "events into durable nodes and reinforces matched existing ones. Returns " +
      "`(promoted, reinforced, skipped)` plus rids and decisions. Requires an active session unless " +
      "`session_id` is supplied.",
    input: z.object({
      triggered_by: z.enum(["explicit", "hook", "overflow"]).optional(),
      session_id: z.string().min(1).optional(),
    }),
  },
  {
    name: "memory_autocure",
    description:
      "Opt-in auto-curation orchestrator (memory.autocure.v1). Default is dry-run: returns proposed " +
      "actions and entropy_before/entropy_after with no mutation. Pass apply=true to execute " +
      "proposals; claim-guarded nodes are never mutated and surface in skipped_claim_guarded.",
    input: z.object({
      apply: z.boolean().optional(),
      stale_days: z.number().int().min(1).optional(),
    }),
  },
];

/** The core surface a session can publish with no daemon reachable. */
export function createRsMemoryCoreTools(): RsMemoryTool[] {
  return CORE_TOOL_SHAPES.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: jsonSchema(tool.input),
  }));
}

/** The core tool names, for a caller that wants the set without the schemas. */
export const RS_MEMORY_CORE_TOOL_NAMES: readonly string[] =
  CORE_TOOL_SHAPES.map((tool) => tool.name);

/**
 * Render one zod object as the shape hint MCP lists.
 *
 * Minimal on purpose — MCP asks for hints, not a complete JSON Schema, and the
 * daemon re-parses every argument against the real schema before it touches a
 * store, so a hint that under-describes costs a clearer error and nothing else.
 */
function jsonSchema(schema: z.ZodObject<z.ZodRawShape>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(schema.shape)) {
    properties[key] = describe(value);
    if (!value.isOptional()) required.push(key);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

function describe(value: z.ZodTypeAny): Record<string, unknown> {
  const def = (value as unknown as { _def: { typeName?: string; innerType?: z.ZodTypeAny } })._def;
  if ((def.typeName === "ZodOptional" || def.typeName === "ZodDefault") && def.innerType) {
    return describe(def.innerType);
  }
  if (def.typeName === "ZodString") return { type: "string" };
  if (def.typeName === "ZodNumber") return { type: "number" };
  if (def.typeName === "ZodBoolean") return { type: "boolean" };
  if (def.typeName === "ZodArray") return { type: "array" };
  if (def.typeName === "ZodObject") return { type: "object" };
  if (def.typeName === "ZodEnum") {
    return { type: "string", enum: (value as unknown as { options: string[] }).options };
  }
  return {};
}
