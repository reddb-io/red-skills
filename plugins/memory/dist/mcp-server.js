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
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { readConfig, resolveStoreUri } from "./config.js";
import { diagnose } from "./doctor.js";
import { runAutoCure } from "./auto-curation.js";
import { neighbors, path, recall, search, traverse } from "./engine.js";
import { exportGraph } from "./export.js";
import { MemoryStore, factToNode } from "./graph-store.js";
import { HistoricalMemoryStore } from "./historical-memory-store.js";
import { executeReadOnlyMemoryOperation, listReadOnlyMemoryOperations, } from "./operations.js";
import { runPromote } from "./promote.js";
import { current as sessionCurrent, end as sessionEnd, start as sessionStart, } from "./session-manager.js";
import { slugify } from "./store.js";
import { listContradictions, supersessionTimeline } from "./supersession.js";
import { appendEvent as workingAppendEvent, listEvents as workingListEvents, } from "./working-memory.js";
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
];
const MEMORY_SCOPES = [
    "user",
    "project",
    "repo",
    "branch",
    "worktree",
    "session",
    "agent-run",
];
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
        .array(z.object({
        label: z.string(),
        target_label: z.string(),
        target_type: z.string().optional(),
    }))
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
const NO_ACTIVE_SESSION_ERROR = "no active memory session — call memory_session_start first (or rely on the SessionStart hook to mint one)";
async function requireActiveSession(rootDir) {
    const id = await sessionCurrent(rootDir);
    if (!id)
        throw new Error(NO_ACTIVE_SESSION_ERROR);
    return id;
}
// ---------- server ----------
async function main() {
    const { uri, project, root } = await resolveStore();
    const store = await MemoryStore.open({ uri, project });
    const server = new Server({ name: "memory", version: "0.1.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const name = req.params.name;
        const args = req.params.arguments ?? {};
        const operation = OPERATION_BY_TOOL_NAME.get(name);
        if (operation) {
            const output = await executeReadOnlyMemoryOperation(operation.id, { store, rootDir: root }, args);
            return text(JSON.stringify(output, null, 2), await operationStructuredContent(operation.id, output, store));
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
                        nodes: result.nodes.map((n) => {
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
                        }),
                        diagnostics: result.diagnostics,
                    });
                }
                finally {
                    if (input.as_of)
                        await recallStore.close();
                }
            }
            case "memory_store": {
                const input = StoreInput.parse(args);
                const node = factToNode(input.title, slugify);
                node.node_type = input.type;
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
                const edges = [];
                for (const rel of input.relations) {
                    const target = await store.findNodeByLabel(rel.target_label);
                    if (target == null)
                        continue;
                    edges.push(await store.upsertEdge({
                        from_rid: rid,
                        to_rid: target,
                        label: rel.label,
                    }));
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
            case "memory_autocure": {
                const input = AutocureInput.parse(args);
                const report = await runAutoCure(store, {
                    apply: input.apply,
                    staleDays: input.stale_days,
                });
                return text(JSON.stringify(report, null, 2), {
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
                return text(`session started — ${id}`, { session_id: id });
            }
            case "memory_session_end": {
                SessionEndInput.parse(args);
                await sessionEnd(root);
                return text("session ended", { ok: true });
            }
            case "memory_working_get": {
                const input = WorkingGetInput.parse(args);
                await requireActiveSession(root);
                const events = await workingListEvents(store, root, input.type ? { type: input.type } : {});
                return text(JSON.stringify({ events }, null, 2), {
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
                return text(JSON.stringify(event, null, 2), {
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
                return text(JSON.stringify(report, null, 2), {
                    session_id: report.session_id,
                    promoted: report.promoted,
                    reinforced: report.reinforced,
                    skipped: report.skipped,
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
        }
        finally {
            process.exit(0);
        }
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}
/** Resolve which RedDB store the server speaks to, and the project tag. */
async function resolveStore() {
    if (process.env.RED_MEMORY_URI) {
        return {
            uri: process.env.RED_MEMORY_URI,
            project: process.env.RED_MEMORY_PROJECT ?? basename(process.cwd()),
            root: process.env.MEMORY_ROOT ?? process.cwd(),
        };
    }
    const root = process.env.MEMORY_ROOT ?? process.cwd();
    const config = await readConfig(root);
    if (!config) {
        throw new Error(`memory is not initialized at ${root} — run \`memory init --mode graph\` first (or set RED_MEMORY_URI)`);
    }
    if (config.mode !== "graph") {
        throw new Error(`the MCP server needs graph mode — ${root} is "${config.mode}". Re-run \`memory init --mode graph\``);
    }
    return {
        uri: resolveStoreUri(root, config),
        project: process.env.RED_MEMORY_PROJECT ?? basename(root),
        root,
    };
}
function text(body, structured) {
    return {
        content: [{ type: "text", text: body }],
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
        description: "Hybrid recall: full-text seeds + graph-neighborhood expansion. Returns a markdown context block ready to inject, plus ranked nodes. Call BEFORE answering when a question depends on prior project knowledge. Zero-token (no LLM).",
        inputSchema: zodToSchema(RecallInput),
    },
    {
        name: "memory_store",
        description: "MUTATING: persist a durable fact (decision, problem, solution, why-note, ...) with optional typed relations to existing nodes. Idempotent by content hash.",
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
        description: "Dump the whole graph (nodes, edges, stats) as JSON. Pass `out_dir` to also write a navigable graph.html + graph.json + audit.md bundle there.",
        inputSchema: zodToSchema(ExportInput),
    },
    {
        name: "memory_doctor",
        description: "Inspect graph health: list stale nodes (unaccessed `stale_days`+ days AND never recalled; pinned nodes exempt). Read-only — pruning is a confirmed CLI operation.",
        inputSchema: zodToSchema(DoctorInput),
    },
    {
        name: "memory_stats",
        description: "Counts of nodes/edges and basic store health.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
        name: "memory_conflicts",
        description: "Read-only contradiction inspection. Lists CONTRADICTS edges that have not converged on the same active supersession head; pass include_resolved to audit resolved conflicts too.",
        inputSchema: zodToSchema(ConflictsInput),
    },
    {
        name: "memory_timeline",
        description: "Read-only topic timeline. Shows active and superseded guidance plus contradiction/supersession audit links for matching memory nodes.",
        inputSchema: zodToSchema(TimelineInput),
    },
    {
        name: "memory_supersede",
        description: "MUTATING: mark a node as superseded by a newer one. Recall hides the old node behind its successor by default.",
        inputSchema: zodToSchema(SupersedeInput),
    },
    {
        name: "memory_session_start",
        description: "MUTATING: mint and write a new memory session id to `.red/memory/sessions/current` (overwriting any existing id). Pass `id` to reuse a runner-supplied session id; otherwise a UUID is minted. Working-memory (L2) reads/writes and promotion all scope to this session id.",
        inputSchema: zodToSchema(SessionStartInput),
    },
    {
        name: "memory_session_end",
        description: "MUTATING: drop `.red/memory/sessions/current`. After this, working-memory and promotion verbs will error until `memory_session_start` (or a SessionStart hook) mints a new id.",
        inputSchema: zodToSchema(SessionEndInput),
    },
    {
        name: "memory_working_get",
        description: "Read typed L2 working-memory events for the current session, oldest first. Optional `type` filter (e.g. `decision_candidate`, `tool_call`). Requires an active session.",
        inputSchema: zodToSchema(WorkingGetInput),
    },
    {
        name: "memory_working_set",
        description: "MUTATING: append a typed event to the current session's L2 working-memory stream. `type` is the event tag, `value` is the verbatim text. Crossing the L2 overflow threshold may trigger a promotion pass as a backstop. Requires an active session.",
        inputSchema: zodToSchema(WorkingSetInput),
    },
    {
        name: "memory_promote",
        description: "MUTATING: run the PromotionEngine for the current session against L3 — promotes new typed L2 events into durable nodes and reinforces matched existing ones. Returns `(promoted, reinforced, skipped)` plus rids and decisions. Requires an active session unless `session_id` is supplied.",
        inputSchema: zodToSchema(PromoteInput),
    },
    {
        name: "memory_autocure",
        description: "Opt-in auto-curation orchestrator (memory.autocure.v1). Default is dry-run: returns proposed actions and entropy_before/entropy_after with no mutation. Pass apply=true to execute proposals; claim-guarded nodes (properties.claim_guard === true) are never mutated and surface in skipped_claim_guarded.",
        inputSchema: zodToSchema(AutocureInput),
    },
];
const TOOLS = [...OPERATION_TOOLS, ...MANUAL_TOOLS];
const OPERATION_BY_TOOL_NAME = new Map(listReadOnlyMemoryOperations().map((operation) => [
    operation.renderer.mcp.toolName,
    operation,
]));
async function operationStructuredContent(operationId, output, store) {
    if (!isRecord(output))
        return { operation_id: operationId };
    switch (operationId) {
        case "memory.ask": {
            const evidence = isRecord(output.evidence) ? output.evidence : {};
            const byConfidence = isRecord(evidence.byConfidence) ? evidence.byConfidence : {};
            const gapAnalysis = isRecord(output.gap_analysis) ? output.gap_analysis : {};
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
                gap_status: gapAnalysis.status ?? null,
                gaps: arrayLength(gapAnalysis.gaps),
                next_actions: arrayLength(gapAnalysis.next_actions),
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
                active_evidence: arrayLength(isRecord(output.evidence) ? output.evidence.active : undefined),
                conflicting_evidence: arrayLength(isRecord(output.evidence) ? output.evidence.conflicting : undefined),
            };
        case "memory.governance": {
            const summary = isRecord(output.summary) ? output.summary : {};
            return {
                operation_id: operationId,
                schema_version: output.schema_version,
                read_only: output.read_only,
                status: output.status,
                total_nodes: summary.total_nodes ?? null,
                missing_provenance: summary.missing_provenance ?? null,
                privacy_findings: summary.privacy_findings ?? null,
                lint_findings: summary.lint_findings ?? null,
                unresolved_contradictions: summary.unresolved_contradictions ?? null,
                superseded_nodes: summary.superseded_nodes ?? null,
                next_actions: arrayLength(output.recommended_next_actions),
            };
        }
        case "memory.governance-viewer": {
            const report = isRecord(output.report) ? output.report : {};
            const summary = isRecord(report.summary) ? report.summary : {};
            return {
                operation_id: operationId,
                contract: isRecord(output.contract) ? output.contract.version : undefined,
                consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
                status: report.status,
                missing_provenance: summary.missing_provenance ?? null,
                privacy_findings: summary.privacy_findings ?? null,
                lint_findings: summary.lint_findings ?? null,
                html_bytes: typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
            };
        }
        case "memory.handoff-viewer": {
            const report = isRecord(output.report) ? output.report : {};
            const summary = isRecord(report.summary) ? report.summary : {};
            return {
                operation_id: operationId,
                contract: isRecord(output.contract) ? output.contract.version : undefined,
                consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
                status: report.status,
                returned_items: summary.returned_items ?? null,
                html_bytes: typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
            };
        }
        case "memory.work-frontier": {
            const summary = isRecord(output.summary) ? output.summary : {};
            return {
                operation_id: operationId,
                schema_version: output.schema_version,
                status: output.status,
                focus: output.focus,
                ready: summary.ready,
                blocked: summary.blocked,
                completed: summary.completed,
                markdown_bytes: typeof output.markdown === "string" ? Buffer.byteLength(output.markdown, "utf8") : 0,
                read_only: output.read_only,
            };
        }
        case "memory.work-frontier-viewer": {
            const report = isRecord(output.report) ? output.report : {};
            const summary = isRecord(report.summary) ? report.summary : {};
            return {
                operation_id: operationId,
                contract: isRecord(output.contract) ? output.contract.version : undefined,
                consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
                status: report.status,
                ready: summary.ready,
                blocked: summary.blocked,
                completed: summary.completed,
                html_bytes: typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
            };
        }
        case "memory.decay": {
            const summary = isRecord(output.summary) ? output.summary : {};
            return {
                operation_id: operationId,
                schema_version: output.schema_version,
                read_only: output.read_only,
                status: output.status,
                keep: summary.keep,
                review: summary.review,
                deprecate: summary.deprecate,
                expire: summary.expire,
                markdown_bytes: typeof output.markdown === "string" ? Buffer.byteLength(output.markdown, "utf8") : 0,
            };
        }
        case "memory.decay-viewer": {
            const report = isRecord(output.report) ? output.report : {};
            const summary = isRecord(report.summary) ? report.summary : {};
            return {
                operation_id: operationId,
                contract: isRecord(output.contract) ? output.contract.version : undefined,
                consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
                status: report.status,
                keep: summary.keep,
                review: summary.review,
                deprecate: summary.deprecate,
                expire: summary.expire,
                html_bytes: typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
            };
        }
        case "memory.asset-inventory":
            return {
                operation_id: operationId,
                schema_version: output.schema_version,
                total_assets: output.total_assets,
                total_bytes: output.total_bytes,
                kinds: arrayLength(output.kinds),
                warnings: arrayLength(output.warnings),
                read_only: output.read_only,
            };
        case "memory.asset-inventory-viewer": {
            const report = isRecord(output.report) ? output.report : {};
            return {
                operation_id: operationId,
                contract_version: isRecord(output.contract) ? output.contract.version : undefined,
                consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
                total_assets: report.total_assets,
                kinds: arrayLength(report.kinds),
                html_bytes: typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
            };
        }
        case "memory.smart-search": {
            const summary = isRecord(output.summary) ? output.summary : {};
            return {
                operation_id: operationId,
                schema_version: output.schema_version,
                read_only: output.read_only,
                recall_hits: summary.recall_hits ?? null,
                doc_hits: summary.doc_hits ?? null,
                asset_hits: summary.asset_hits ?? null,
                vector_hits: summary.vector_hits ?? null,
                vector_status: summary.vector_status ?? null,
                top_results: arrayLength(output.top_results),
                next_actions: arrayLength(output.recommended_next_actions),
            };
        }
        case "memory.smart-search-viewer": {
            const report = isRecord(output.report) ? output.report : {};
            const summary = isRecord(report.summary) ? report.summary : {};
            return {
                operation_id: operationId,
                contract: isRecord(output.contract) ? output.contract.version : undefined,
                consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
                query: report.query,
                recall_hits: summary.recall_hits ?? null,
                doc_hits: summary.doc_hits ?? null,
                asset_hits: summary.asset_hits ?? null,
                vector_hits: summary.vector_hits ?? null,
                top_results: arrayLength(report.top_results),
                html_bytes: typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
            };
        }
        case "memory.doc-bundle":
            return {
                operation_id: operationId,
                schema_version: output.schema_version,
                query: output.query,
                total_docs: output.total_docs,
                hits: arrayLength(output.hits),
                packs: arrayLength(output.packs),
                warnings: arrayLength(output.warnings),
                markdown_bytes: typeof output.markdown === "string"
                    ? Buffer.byteLength(output.markdown, "utf8")
                    : 0,
                read_only: output.read_only,
            };
        case "memory.doc-brief":
            return {
                operation_id: operationId,
                schema_version: output.schema_version,
                query: output.query,
                status: output.status,
                citations: arrayLength(output.citations),
                gaps: arrayLength(output.gaps),
                next_actions: arrayLength(output.next_actions),
                markdown_bytes: typeof output.markdown === "string"
                    ? Buffer.byteLength(output.markdown, "utf8")
                    : 0,
                read_only: output.read_only,
            };
        case "memory.doc-brief-viewer": {
            const brief = isRecord(output.brief) ? output.brief : {};
            return {
                operation_id: operationId,
                contract: isRecord(output.contract) ? output.contract.version : undefined,
                consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
                schema_version: brief.schema_version,
                query: brief.query,
                status: brief.status,
                citations: arrayLength(brief.citations),
                gaps: arrayLength(brief.gaps),
                html_bytes: typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
                read_only: brief.read_only,
            };
        }
        case "memory.doc-bundle-viewer": {
            const bundle = isRecord(output.bundle) ? output.bundle : {};
            return {
                operation_id: operationId,
                contract: isRecord(output.contract) ? output.contract.version : undefined,
                consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
                schema_version: bundle.schema_version,
                query: bundle.query,
                hits: arrayLength(bundle.hits),
                packs: arrayLength(bundle.packs),
                warnings: arrayLength(bundle.warnings),
                html_bytes: typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
                read_only: bundle.read_only,
            };
        }
        case "memory.capability-catalog": {
            const summary = isRecord(output.summary) ? output.summary : {};
            const runtime = isRecord(output.runtime) ? output.runtime : {};
            const stats = isRecord(runtime.stats) ? runtime.stats : {};
            return {
                operation_id: operationId,
                schema_version: output.schema_version,
                total: summary.total,
                ready: summary.ready,
                degraded: summary.degraded,
                not_configured: summary.not_configured,
                red_db_backed: summary.red_db_backed,
                categories: arrayLength(output.categories),
                nodes: stats.nodes,
                edges: stats.edges,
                read_only: output.read_only,
            };
        }
        case "memory.competitive-radar": {
            const summary = isRecord(output.summary) ? output.summary : {};
            return {
                operation_id: operationId,
                schema_version: output.schema_version,
                read_only: output.read_only,
                competitors: summary.competitors,
                total_relevant_capabilities: summary.total_relevant_capabilities,
                degraded_or_not_configured: summary.degraded_or_not_configured,
                recommended_next_actions: arrayLength(output.recommended_next_actions),
            };
        }
        case "memory.competitive-eval": {
            const composite = isRecord(output.composite) ? output.composite : {};
            const claimGuards = isRecord(output.claimGuards) ? output.claimGuards : {};
            return {
                operation_id: operationId,
                schema_version: output.schemaVersion,
                score: composite.score,
                max_score: composite.maxScore,
                status: composite.status,
                dimensions: arrayLength(output.dimensions),
                live_baselines: arrayLength(output.liveBaselines),
                claim_guards: claimGuards.status,
            };
        }
        case "memory.competitive-eval-viewer": {
            const report = isRecord(output.report) ? output.report : {};
            const composite = isRecord(report.composite) ? report.composite : {};
            return {
                operation_id: operationId,
                contract_version: isRecord(output.contract) ? output.contract.version : undefined,
                consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
                score: composite.score,
                max_score: composite.maxScore,
                status: composite.status,
                html_bytes: typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
            };
        }
        case "memory.communities": {
            const stats = await store.stats();
            return {
                operation_id: operationId,
                schema_version: output.schema_version,
                read_only: output.read_only,
                communities: arrayLength(output.communities),
                assignments: arrayLength(output.assignments),
                graph_hash: output.graph_hash,
                cached: output.cached,
                nodes: stats.nodes,
                edges: stats.edges,
            };
        }
        case "memory.communities-viewer": {
            const report = isRecord(output.report) ? output.report : {};
            return {
                operation_id: operationId,
                contract: isRecord(output.contract) ? output.contract.version : undefined,
                consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
                communities: arrayLength(report.communities),
                assignments: arrayLength(report.assignments),
                graph_hash: report.graph_hash,
                cached: report.cached,
                html_bytes: typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
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
        case "memory.context-pack-viewer": {
            const pack = isRecord(output.pack) ? output.pack : {};
            return {
                operation_id: operationId,
                contract: isRecord(output.contract) ? output.contract.version : undefined,
                consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
                status: pack.status,
                entries: arrayLength(pack.entries),
                warnings: arrayLength(pack.warnings),
                omitted_entries: pack.omittedEntries,
                html_bytes: typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
            };
        }
        case "memory.dashboard": {
            const dashboard = isRecord(output.dashboard) ? output.dashboard : {};
            const stats = isRecord(dashboard.stats) ? dashboard.stats : {};
            return {
                operation_id: operationId,
                contract_version: isRecord(output.contract) ? output.contract.version : undefined,
                consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
                state: dashboard.state,
                nodes: stats.nodes,
                edges: stats.edges,
                docs: stats.docs,
                warnings: arrayLength(dashboard.warnings),
                html_bytes: typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
            };
        }
        case "memory.doc-read":
            return {
                operation_id: operationId,
                found: output.found,
                matched_by: output.matched_by,
                rid: output.rid,
                path: output.path,
                body_bytes: output.body_bytes,
                returned_bytes: output.returned_bytes,
                truncated: output.truncated,
            };
        case "memory.doc-evidence-pack": {
            const doc = isRecord(output.doc) ? output.doc : {};
            const related = isRecord(output.related) ? output.related : {};
            return {
                operation_id: operationId,
                schema_version: output.schema_version,
                found: output.found,
                matched_by: output.matched_by,
                path: doc.path,
                rid: doc.rid,
                references: arrayLength(related.references),
                related_docs: arrayLength(related.related_docs),
                warnings: arrayLength(output.warnings),
                markdown_bytes: typeof output.markdown === "string"
                    ? Buffer.byteLength(output.markdown, "utf8")
                    : 0,
                read_only: output.read_only,
            };
        }
        case "memory.doc-evidence-pack-viewer": {
            const pack = isRecord(output.pack) ? output.pack : {};
            const doc = isRecord(pack.doc) ? pack.doc : {};
            const related = isRecord(pack.related) ? pack.related : {};
            return {
                operation_id: operationId,
                contract: isRecord(output.contract) ? output.contract.version : undefined,
                consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
                schema_version: pack.schema_version,
                found: pack.found,
                path: doc.path,
                rid: doc.rid,
                references: arrayLength(related.references),
                related_docs: arrayLength(related.related_docs),
                warnings: arrayLength(pack.warnings),
                html_bytes: typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
                read_only: pack.read_only,
            };
        }
        case "memory.doc-backlinks":
            return {
                operation_id: operationId,
                schema_version: output.schema_version,
                found: output.found,
                matched_by: output.matched_by,
                references: arrayLength(output.references),
                docs: arrayLength(output.docs),
                warnings: arrayLength(output.warnings),
                read_only: output.read_only,
            };
        case "memory.doc-backlinks-viewer": {
            const report = isRecord(output.report) ? output.report : {};
            return {
                operation_id: operationId,
                contract_version: isRecord(output.contract) ? output.contract.version : undefined,
                consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
                found: report.found,
                references: arrayLength(report.references),
                docs: arrayLength(report.docs),
                html_bytes: typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
            };
        }
        case "memory.doc-related":
            return {
                operation_id: operationId,
                schema_version: output.schema_version,
                found: output.found,
                matched_by: output.matched_by,
                target: isRecord(output.target) ? output.target.path ?? output.target.label : undefined,
                references: arrayLength(output.references),
                related_docs: arrayLength(output.related_docs),
                warnings: arrayLength(output.warnings),
                read_only: output.read_only,
            };
        case "memory.doc-related-viewer": {
            const report = isRecord(output.report) ? output.report : {};
            return {
                operation_id: operationId,
                contract_version: isRecord(output.contract) ? output.contract.version : undefined,
                consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
                found: report.found,
                references: arrayLength(report.references),
                related_docs: arrayLength(report.related_docs),
                html_bytes: typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
            };
        }
        case "memory.doc-coverage":
            return {
                operation_id: operationId,
                schema_version: output.schema_version,
                total_docs: output.total_docs,
                grounded_docs: output.grounded_docs,
                ungrounded_docs: output.ungrounded_docs,
                docs_with_references: output.docs_with_references,
                total_references: output.total_references,
                vector_overall: isRecord(output.vector) ? output.vector.overall : undefined,
                warnings: arrayLength(output.warnings),
                read_only: output.read_only,
            };
        case "memory.doc-coverage-viewer": {
            const report = isRecord(output.report) ? output.report : {};
            return {
                operation_id: operationId,
                contract_version: isRecord(output.contract) ? output.contract.version : undefined,
                consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
                total_docs: report.total_docs,
                grounded_docs: report.grounded_docs,
                warnings: arrayLength(report.warnings),
                html_bytes: typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
            };
        }
        case "memory.doc-reference-graph":
            return {
                operation_id: operationId,
                schema_version: output.schema_version,
                total_docs: output.total_docs,
                grounded_docs: output.grounded_docs,
                reference_nodes: output.reference_nodes,
                reference_edges: output.reference_edges,
                top_references: arrayLength(output.top_references),
                warnings: arrayLength(output.warnings),
                read_only: output.read_only,
            };
        case "memory.doc-reference-graph-viewer": {
            const report = isRecord(output.report) ? output.report : {};
            return {
                operation_id: operationId,
                contract_version: isRecord(output.contract) ? output.contract.version : undefined,
                consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
                total_docs: report.total_docs,
                reference_nodes: report.reference_nodes,
                reference_edges: report.reference_edges,
                html_bytes: typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
            };
        }
        case "memory.doc-search":
            return {
                operation_id: operationId,
                query: output.query,
                total_docs: output.total_docs,
                hits: arrayLength(output.hits),
            };
        case "memory.doc-search-viewer": {
            const report = isRecord(output.report) ? output.report : {};
            return {
                operation_id: operationId,
                contract: isRecord(output.contract) ? output.contract.version : undefined,
                consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
                query: report.query,
                total_docs: report.total_docs,
                hits: arrayLength(report.hits),
                html_bytes: typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
            };
        }
        case "memory.extraction-status": {
            const deterministic = isRecord(output.deterministic) ? output.deterministic : {};
            const inferred = isRecord(output.inferred) ? output.inferred : {};
            return {
                operation_id: operationId,
                schema_version: output.schema_version,
                read_only: output.read_only,
                deterministic_ready: Object.values(deterministic).filter(Boolean).length,
                inferred_configured: inferred.configured ?? null,
                inferred_available: inferred.available ?? null,
                inferred_facts: inferred.facts ?? null,
                hook_stop_enabled: inferred.hook_stop_enabled ?? null,
                next_actions: arrayLength(output.recommended_next_actions),
            };
        }
        case "memory.extraction-status-viewer": {
            const status = isRecord(output.status) ? output.status : {};
            const deterministic = isRecord(status.deterministic) ? status.deterministic : {};
            const inferred = isRecord(status.inferred) ? status.inferred : {};
            return {
                operation_id: operationId,
                contract: isRecord(output.contract) ? output.contract.version : undefined,
                consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
                deterministic_ready: Object.values(deterministic).filter(Boolean).length,
                inferred_available: inferred.available ?? null,
                inferred_facts: inferred.facts ?? null,
                html_bytes: typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
            };
        }
        case "memory.health":
            return {
                operation_id: operationId,
                schema_version: output.schema_version,
                read_only: output.read_only,
                state: output.state,
                stats: output.stats,
                stale: isRecord(output.stale) ? output.stale.stale : undefined,
            };
        case "memory.health-viewer": {
            const report = isRecord(output.report) ? output.report : {};
            return {
                operation_id: operationId,
                contract: isRecord(output.contract) ? output.contract.version : undefined,
                consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
                state: report.state,
                html_bytes: typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
            };
        }
        case "memory.handoff": {
            const summary = isRecord(output.summary) ? output.summary : {};
            return {
                operation_id: operationId,
                schema_version: output.schema_version,
                status: output.status,
                focus: output.focus,
                returned_items: summary.returned_items,
                active_work: summary.active_work,
                decisions: summary.decisions,
                validations: summary.validations,
                risks: summary.risks,
                context: summary.context,
                markdown_bytes: typeof output.markdown === "string" ? Buffer.byteLength(output.markdown, "utf8") : 0,
                read_only: output.read_only,
            };
        }
        case "memory.hook-coverage": {
            const summary = isRecord(output.summary) ? output.summary : {};
            return {
                operation_id: operationId,
                schema_version: output.schema_version,
                mode: output.mode,
                config_found: output.config_found,
                total_events: summary.total_events,
                wired_events: summary.wired_events,
                enabled_events: summary.enabled_events,
                gaps: arrayLength(output.gaps),
                read_only: output.read_only,
            };
        }
        case "memory.hook-coverage-viewer": {
            const report = isRecord(output.report) ? output.report : {};
            const summary = isRecord(report.summary) ? report.summary : {};
            return {
                operation_id: operationId,
                contract: isRecord(output.contract) ? output.contract.version : undefined,
                consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
                mode: report.mode,
                effective_events: summary.effective_events,
                total_events: summary.total_events,
                actionable_gaps: summary.actionable_gaps,
                html_bytes: typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
            };
        }
        case "memory.learning-debt":
            return {
                operation_id: operationId,
                schema_version: output.schema_version,
                read_only: output.read_only,
                status: output.status,
                summary: output.summary,
            };
        case "memory.learning-debt-viewer": {
            const report = isRecord(output.report) ? output.report : {};
            return {
                operation_id: operationId,
                contract: isRecord(output.contract) ? output.contract.version : undefined,
                consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
                status: report.status,
                summary: report.summary,
                html_bytes: typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
            };
        }
        case "memory.layers": {
            const summary = isRecord(output.summary) ? output.summary : {};
            return {
                operation_id: operationId,
                schema_version: output.schema_version,
                total_layers: summary.total_layers,
                ready_layers: summary.ready_layers,
                red_db_backed_layers: summary.red_db_backed_layers,
                layers: arrayLength(output.layers),
                competitor_alignment: arrayLength(output.competitor_alignment),
                read_only: output.read_only,
            };
        }
        case "memory.layers-viewer": {
            const report = isRecord(output.report) ? output.report : {};
            const summary = isRecord(report.summary) ? report.summary : {};
            return {
                operation_id: operationId,
                contract: isRecord(output.contract) ? output.contract.version : undefined,
                consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
                total_layers: summary.total_layers,
                ready_layers: summary.ready_layers,
                red_db_backed_layers: summary.red_db_backed_layers,
                html_bytes: typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
            };
        }
        case "memory.onboarding-map":
            return {
                operation_id: operationId,
                schema_version: output.schema_version,
                read_only: output.read_only,
                status: output.status,
                summary: output.summary,
                warnings: arrayLength(output.warnings),
            };
        case "memory.onboarding-map-viewer": {
            const map = isRecord(output.map) ? output.map : {};
            return {
                operation_id: operationId,
                contract: isRecord(output.contract) ? output.contract.version : undefined,
                consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
                status: map.status,
                summary: map.summary,
                warnings: arrayLength(map.warnings),
                html_bytes: typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
            };
        }
        case "memory.confidence": {
            const node = isRecord(output.node) ? output.node : {};
            return {
                operation_id: operationId,
                schema_version: output.schema_version,
                read_only: output.read_only,
                node_rid: node.rid,
                confidence: output.confidence,
            };
        }
        case "memory.federation":
            return {
                operation_id: operationId,
                schema_version: output.schema_version,
                read_only: output.read_only,
                query: output.query,
                roots_queried: output.roots_queried,
                result_count: arrayLength(output.results),
            };
        case "memory.path-explain":
            return {
                operation_id: operationId,
                schema_version: output.schema_version,
                reachable: output.reachable,
                hop_count: output.hop_count,
                path_nodes: arrayLength(output.path),
                path_edges: arrayLength(output.edges),
                markdown_bytes: typeof output.markdown === "string" ? Buffer.byteLength(output.markdown, "utf8") : 0,
                read_only: output.read_only,
            };
        case "memory.path-explain-viewer": {
            const report = isRecord(output.report) ? output.report : {};
            return {
                operation_id: operationId,
                contract_version: isRecord(output.contract) ? output.contract.version : undefined,
                consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
                reachable: report.reachable,
                hop_count: report.hop_count,
                path_nodes: arrayLength(report.path),
                path_edges: arrayLength(report.edges),
                html_bytes: typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
            };
        }
        case "memory.lint":
            return {
                operation_id: operationId,
                status: output.status,
                findings: arrayLength(output.findings),
                rule_suggestions: arrayLength(output.ruleSuggestions),
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
        case "memory.pre-pr-review":
            return {
                operation_id: operationId,
                changed_files: arrayLength(output.changedFiles),
                impacted_concepts: sectionItemCount(output.impactedConcepts),
                related_decisions: sectionItemCount(output.relatedDecisions),
                known_failures: sectionItemCount(output.knownFailures),
                suggested_validations: sectionItemCount(output.suggestedValidations),
                risks: sectionItemCount(output.risks),
                evidence: arrayLength(output.evidence),
                missing_evidence: arrayLength(output.missingEvidence),
                read_only: output.readOnly,
            };
        case "memory.pre-pr-review-viewer": {
            const review = isRecord(output.review) ? output.review : {};
            return {
                operation_id: operationId,
                contract_version: isRecord(output.contract) ? output.contract.version : undefined,
                consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
                changed_files: arrayLength(review.changedFiles),
                evidence: arrayLength(review.evidence),
                risks: sectionItemCount(review.risks),
                missing_evidence: arrayLength(review.missingEvidence),
                html_bytes: typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
            };
        }
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
                active_evidence: arrayLength(isRecord(output.evidence) ? output.evidence.active : undefined),
                next_actions: arrayLength(output.next_actions),
            };
        case "memory.readiness-viewer": {
            const envelope = isRecord(output.envelope) ? output.envelope : {};
            const evidence = isRecord(envelope.evidence) ? envelope.evidence : {};
            return {
                operation_id: operationId,
                contract_version: isRecord(output.contract) ? output.contract.version : undefined,
                consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
                readiness_status: envelope.status,
                active_evidence: arrayLength(evidence.active),
                html_bytes: typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
            };
        }
        case "memory.routing-guide":
            return {
                operation_id: operationId,
                schema_version: output.schemaVersion,
                agent: output.agent,
                supported_agents: arrayLength(output.supportedAgents),
                transports: isRecord(output.integration)
                    ? arrayLength(output.integration.transports)
                    : undefined,
                target_files: arrayLength(output.targetFiles),
                mcp_tools: arrayLength(output.mcpTools),
                config_snippets: isRecord(output.integration)
                    ? arrayLength(output.integration.configSnippets)
                    : undefined,
                rules: arrayLength(output.rules),
                safety_notes: arrayLength(output.safetyNotes),
                snippet_bytes: typeof output.installSnippet === "string"
                    ? Buffer.byteLength(output.installSnippet, "utf8")
                    : 0,
            };
        case "memory.routing-guide-viewer": {
            const guide = isRecord(output.guide) ? output.guide : {};
            const integration = isRecord(guide.integration) ? guide.integration : {};
            return {
                operation_id: operationId,
                contract_version: isRecord(output.contract) ? output.contract.version : undefined,
                consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
                agent: guide.agent,
                transports: arrayLength(integration.transports),
                target_files: arrayLength(guide.targetFiles),
                mcp_tools: arrayLength(guide.mcpTools),
                html_bytes: typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
            };
        }
        case "memory.agent-integration-status":
            return {
                operation_id: operationId,
                schema_version: output.schema_version,
                mode: output.mode,
                agents: isRecord(output.summary) ? output.summary.agents : undefined,
                ready: isRecord(output.summary) ? output.summary.ready : undefined,
                partial: isRecord(output.summary) ? output.summary.partial : undefined,
                missing: isRecord(output.summary) ? output.summary.missing : undefined,
                next_actions: arrayLength(output.recommended_next_actions),
            };
        case "memory.agent-integration-status-viewer": {
            const report = isRecord(output.report) ? output.report : {};
            const summary = isRecord(report.summary) ? report.summary : {};
            return {
                operation_id: operationId,
                contract_version: isRecord(output.contract) ? output.contract.version : undefined,
                consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
                agents: summary.agents,
                ready: summary.ready,
                html_bytes: typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
            };
        }
        case "memory.skill-recommendations":
            return {
                operation_id: operationId,
                status: output.status,
                recommendations: arrayLength(output.recommendations),
                missing_evidence: arrayLength(output.missingEvidence),
            };
        case "memory.structural-impact":
            return {
                operation_id: operationId,
                imports: arrayLength(output.imports),
                imported_by: arrayLength(output.importedBy),
                calls: arrayLength(output.calls),
                called_by: arrayLength(output.calledBy),
                uses_types: arrayLength(output.usesTypes),
                used_by_types: arrayLength(output.usedByTypes),
                defines: arrayLength(output.defines),
                defined_in: isRecord(output.definedIn) ? output.definedIn.label : null,
            };
        case "memory.structural-impact-viewer": {
            const impact = isRecord(output.impact) ? output.impact : {};
            return {
                operation_id: operationId,
                contract_version: isRecord(output.contract) ? output.contract.version : undefined,
                consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
                imports: arrayLength(impact.imports),
                calls: arrayLength(impact.calls),
                uses_types: arrayLength(impact.usesTypes),
                html_bytes: typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
            };
        }
        case "memory.vector-status":
            return {
                operation_id: operationId,
                schema_version: output.schema_version,
                read_only: output.read_only,
                overall: output.overall,
                total: output.total,
                ready: output.ready,
                stale: output.stale,
                unavailable: output.unavailable,
                failed: output.failed,
            };
        case "memory.vector-status-viewer": {
            const report = isRecord(output.report) ? output.report : {};
            return {
                operation_id: operationId,
                contract: isRecord(output.contract) ? output.contract.version : undefined,
                consumes: isRecord(output.contract) ? output.contract.consumes : undefined,
                overall: report.overall,
                total: report.total,
                ready: report.ready,
                stale: report.stale,
                unavailable: report.unavailable,
                failed: report.failed,
                html_bytes: typeof output.html === "string" ? Buffer.byteLength(output.html, "utf8") : 0,
            };
        }
        case "memory.vector-search":
            return {
                operation_id: operationId,
                status: output.status,
                query: output.query,
                limit: output.limit,
                hits: arrayLength(output.hits),
                error: output.error,
                read_only: output.read_only,
            };
        default:
            return { operation_id: operationId };
    }
}
function extractMcpHookEntries(raw) {
    if (!Array.isArray(raw) || raw.length === 0)
        return null;
    const out = [];
    for (const item of raw) {
        if (item == null || typeof item !== "object")
            continue;
        const entry = item;
        const lifecycle = typeof entry.lifecycle === "string" ? entry.lifecycle : "";
        const command = typeof entry.command === "string" ? entry.command : "";
        const exit = entry.exit_code;
        const exit_code = typeof exit === "number" && Number.isFinite(exit)
            ? exit
            : typeof exit === "string" && /^-?\d+$/.test(exit.trim())
                ? Number(exit.trim())
                : NaN;
        if (!lifecycle || !command || !Number.isFinite(exit_code))
            continue;
        out.push({ lifecycle, command, exit_code });
    }
    return out.length > 0 ? out : null;
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function arrayLength(value) {
    return Array.isArray(value) ? value.length : 0;
}
function sectionItemCount(value) {
    return isRecord(value) ? arrayLength(value.items) : 0;
}
function zodToSchema(schema) {
    // Minimal conversion — MCP only requires shape hints, not a full JSON Schema.
    const shape = schema._def.shape?.();
    if (!shape)
        return { type: "object", additionalProperties: true };
    const properties = {};
    const required = [];
    for (const [key, value] of Object.entries(shape)) {
        properties[key] = describe(value);
        if (!value.isOptional())
            required.push(key);
    }
    return { type: "object", properties, required, additionalProperties: false };
}
function describe(v) {
    const def = v
        ._def;
    if (def.typeName === "ZodOptional" || def.typeName === "ZodDefault") {
        if (def.innerType)
            return describe(def.innerType);
    }
    if (def.typeName === "ZodString")
        return { type: "string" };
    if (def.typeName === "ZodNumber")
        return { type: "number" };
    if (def.typeName === "ZodBoolean")
        return { type: "boolean" };
    if (def.typeName === "ZodArray")
        return { type: "array" };
    if (def.typeName === "ZodEnum") {
        return { type: "string", enum: v.options };
    }
    return {};
}
main().catch((err) => {
    console.error("[memory-mcp] fatal:", err);
    process.exit(1);
});
