import { z } from "zod";
import { claimCheck, type ClaimCheckResult } from "./claim-check.js";
import {
  buildCommunityAnalytics,
  type CommunityAnalyticsReport,
  type CommunityCacheMode,
} from "./communities.js";
import { buildContextPack, type ContextPack } from "./context-pack.js";
import { diagnose, type DoctorReport } from "./doctor.js";
import { ask, type AskResult } from "./engine.js";
import type { MemoryStore, StoredNode, VectorStatusReport } from "./graph-store.js";
import { buildLearningDebtReport, type LearningDebtReport } from "./learning-debt.js";
import { lintMemoryRecords, type LintMemoryRecord, type LintReport } from "./lint.js";
import {
  privacyReport,
  type PrivacyMemoryRecord,
  type PrivacyReport,
} from "./privacy.js";
import {
  buildProvenanceReport,
  findNodeForProvenance,
  type ProvenanceReport,
} from "./provenance.js";
import { buildReadinessEnvelope, type MemoryReadinessEnvelope } from "./readiness.js";
import type { MemoryScope, Tier } from "./schema.js";
import {
  buildSkillRecommendations,
  type SkillRecommendationReport,
} from "./skill-recommendations.js";
import { readSkillRollups, type SkillRollup } from "./skill-events.js";

export type MemoryOperationSafetyClass = "read-only" | "mutating";
export type MemoryOperationSideEffectClass = "none" | "cache-write" | "writes-memory";
export type MemoryOperationCapability = "graph-store";

export interface MemoryOperationRendererMetadata {
  cli: {
    command: string;
    supportsJson: boolean;
  };
  mcp: {
    toolName: string;
    description: string;
  };
}

export interface MemoryOperationContext {
  store: MemoryStore;
}

export interface MemoryOperation<Input, Output> {
  id: string;
  title: string;
  description: string;
  inputSchema: z.ZodType<Input, z.ZodTypeDef, unknown>;
  outputSchema: z.ZodType<Output, z.ZodTypeDef, unknown>;
  safetyClass: MemoryOperationSafetyClass;
  sideEffectClass: MemoryOperationSideEffectClass;
  capabilities: readonly MemoryOperationCapability[];
  renderer: MemoryOperationRendererMetadata;
  execute: (ctx: MemoryOperationContext, input: Input) => Promise<Output>;
}

export type ReadOnlyMemoryOperation<Input = unknown, Output = unknown> = MemoryOperation<
  Input,
  Output
> & {
  safetyClass: "read-only";
  sideEffectClass: "none" | "cache-write";
};

export interface ReadOnlyMemoryOperationRegistry {
  list(): ReadOnlyMemoryOperation[];
  get(id: string): ReadOnlyMemoryOperation;
  execute(id: string, ctx: MemoryOperationContext, input: unknown): Promise<unknown>;
}

const CommunityCacheSchema = z.enum(["read-write", "read-only", "off"]).default("read-only");

const MEMORY_SCOPES = [
  "user",
  "project",
  "repo",
  "branch",
  "worktree",
  "session",
  "agent-run",
] as const satisfies readonly MemoryScope[];

const ScopeInputSchema = z.object({
  scope: z.enum(MEMORY_SCOPES).optional(),
  scope_id: z.string().optional(),
  include_narrower_scopes: z.boolean().default(false),
});

const AskInputSchema = z.object({ question: z.string().min(1) });
type AskInput = z.infer<typeof AskInputSchema>;

const ReadinessInputSchema = ScopeInputSchema.extend({
  goal: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
  min_evidence: z.number().int().min(0).max(50).optional(),
  stale_days: z.number().int().min(1).optional(),
});
type ReadinessInput = z.infer<typeof ReadinessInputSchema>;

const ContextPackInputSchema = ScopeInputSchema.extend({
  goal: z.string().min(1),
  budget_chars: z.number().int().min(0).max(100_000).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  depth: z.number().int().min(0).max(5).optional(),
});
type ContextPackInput = z.infer<typeof ContextPackInputSchema>;

const ClaimCheckInputSchema = z.object({ assertion: z.string().min(1) });
type ClaimCheckInput = z.infer<typeof ClaimCheckInputSchema>;

const ProvenanceInputSchema = z.object({ target: z.string().min(1) });
type ProvenanceInput = z.infer<typeof ProvenanceInputSchema>;

const LintInputSchema = z.object({
  stale_progress_days: z.number().int().min(1).optional(),
});
type LintInput = z.infer<typeof LintInputSchema>;

const SkillRecommendationsInputSchema = ScopeInputSchema.extend({
  task: z.string().min(1),
  limit: z.number().int().min(1).max(20).optional(),
  depth: z.number().int().min(0).max(5).optional(),
});
type SkillRecommendationsInput = z.infer<typeof SkillRecommendationsInputSchema>;

const LearningDebtInputSchema = z.object({
  stale_days: z.number().int().min(1).optional(),
  min_repeated_failures: z.number().int().min(2).optional(),
});
type LearningDebtInput = z.infer<typeof LearningDebtInputSchema>;

const HealthInputSchema = z.object({
  stale_days: z.number().int().min(1).default(90),
});
type HealthInput = z.infer<typeof HealthInputSchema>;

const CommunitiesInputSchema = z.object({
  cache: CommunityCacheSchema,
});
type CommunitiesInput = z.infer<typeof CommunitiesInputSchema>;

const CommunitySummarySchema = z.object({
  id: z.string(),
  count: z.number(),
  labels: z.array(z.string()),
  titles: z.array(z.string()),
});

const CommunityAssignmentSchema = z.object({
  rid: z.number(),
  community_id: z.string(),
  label: z.string(),
  node_type: z.string(),
  title: z.string(),
});

const CommunitiesOutputSchema = z.object({
  graph_hash: z.string(),
  cache_key: z.string(),
  cached: z.boolean(),
  generated_at: z.string(),
  communities: z.array(CommunitySummarySchema),
  assignments: z.array(CommunityAssignmentSchema),
}) satisfies z.ZodType<CommunityAnalyticsReport>;

const AskOutputSchema = objectOutputSchema<AskResult>();
const ReadinessOutputSchema = objectOutputSchema<MemoryReadinessEnvelope>();
const ContextPackOutputSchema = objectOutputSchema<ContextPack>();
const ClaimCheckOutputSchema = objectOutputSchema<ClaimCheckResult>();
const ProvenanceOutputSchema = objectOutputSchema<ProvenanceReport>();
const PrivacyOutputSchema = objectOutputSchema<PrivacyReport>();
const LintOutputSchema = objectOutputSchema<LintReport>();
const SkillRecommendationsOutputSchema = objectOutputSchema<SkillRecommendationReport>();
const LearningDebtOutputSchema = objectOutputSchema<LearningDebtReport>();

interface MemoryHealthReport {
  state: "ready" | "attention" | "degraded";
  read_only: true;
  stats: Awaited<ReturnType<MemoryStore["stats"]>>;
  vector: Pick<
    VectorStatusReport,
    "overall" | "total" | "ready" | "stale" | "unavailable" | "failed"
  > & { error?: string };
  stale: {
    total: number;
    stale: number;
  };
  skill_telemetry: {
    status: "available" | "unavailable";
    rollups: number;
    error?: string;
  };
  recommended_next_actions: string[];
}

const HealthOutputSchema = objectOutputSchema<MemoryHealthReport>();

const ASK_OPERATION: MemoryOperation<AskInput, AskResult> = {
  id: "memory.ask",
  title: "Evidence-backed Memory ask",
  description: "Grounded ASK over Memory evidence with citations and provider cost metadata.",
  inputSchema: AskInputSchema,
  outputSchema: AskOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "cache-write",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "ask", supportsJson: true },
    mcp: {
      toolName: "memory_ask",
      description:
        "Read-only evidence-backed ASK over Memory evidence. Returns grounded answer status, citations, active/superseded/contradictory evidence, and provider cost metadata when available.",
    },
  },
  execute: (ctx, input) => ask(ctx.store, input.question),
};

const READINESS_OPERATION: MemoryOperation<ReadinessInput, MemoryReadinessEnvelope> = {
  id: "memory.readiness",
  title: "Memory readiness",
  description: "Stable readiness envelope for an implementation goal.",
  inputSchema: ReadinessInputSchema,
  outputSchema: ReadinessOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "cache-write",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "readiness", supportsJson: true },
    mcp: {
      toolName: "memory_readiness",
      description:
        "Read-only Memory readiness envelope (memory.readiness.v1) for a goal, including evidence, retrieval, trust, privacy, claim-check, skill, learning-debt, and next-action signals.",
    },
  },
  execute: (ctx, input) =>
    buildReadinessEnvelope(ctx.store, input.goal, {
      limit: input.limit,
      minEvidence: input.min_evidence,
      staleDays: input.stale_days,
      scope: scopeFromInput(input),
    }),
};

const CONTEXT_PACK_OPERATION: MemoryOperation<ContextPackInput, ContextPack> = {
  id: "memory.context-pack",
  title: "Memory context pack",
  description: "Agent-ready context pack for a goal from active Memory evidence.",
  inputSchema: ContextPackInputSchema,
  outputSchema: ContextPackOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "cache-write",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "context pack", supportsJson: true },
    mcp: {
      toolName: "memory_context_pack",
      description:
        "Read-only agent context pack for a goal. Returns grouped evidence, warnings, citations, markdown, and skill recommendations without writing graph facts.",
    },
  },
  execute: (ctx, input) =>
    buildContextPack(ctx.store, input.goal, {
      budgetChars: input.budget_chars,
      limit: input.limit,
      depth: input.depth,
      scope: scopeFromInput(input),
    }),
};

const CLAIM_CHECK_OPERATION: MemoryOperation<ClaimCheckInput, ClaimCheckResult> = {
  id: "memory.claim-check",
  title: "Memory claim-check",
  description: "Verify an assertion against local Memory evidence.",
  inputSchema: ClaimCheckInputSchema,
  outputSchema: ClaimCheckOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "cache-write",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "claim-check", supportsJson: true },
    mcp: {
      toolName: "memory_claim_check",
      description:
        "Read-only claim-check against local Memory evidence. Returns supported/contradicted/superseded/insufficient status with citations and conflicting evidence.",
    },
  },
  execute: (ctx, input) => claimCheck(ctx.store, input.assertion),
};

const PROVENANCE_OPERATION: MemoryOperation<ProvenanceInput, ProvenanceReport> = {
  id: "memory.provenance",
  title: "Memory provenance",
  description: "Inspect provenance for a Memory node.",
  inputSchema: ProvenanceInputSchema,
  outputSchema: ProvenanceOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "provenance", supportsJson: true },
    mcp: {
      toolName: "memory_provenance",
      description:
        "Read-only provenance audit for a Memory node by rid or label. Returns writer, source kind, scope, timestamps, confidence, and evidence references.",
    },
  },
  execute: async (ctx, input) => {
    const node = await findNodeForProvenance(ctx.store, input.target);
    if (!node) throw new Error(`memory provenance target not found: ${input.target}`);
    return buildProvenanceReport(node);
  },
};

const PRIVACY_OPERATION: MemoryOperation<object, PrivacyReport> = {
  id: "memory.privacy-scan",
  title: "Memory privacy scan",
  description: "Read-only sensitive-data scan over graph Memory records.",
  inputSchema: z.object({}),
  outputSchema: PrivacyOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "privacy scan", supportsJson: true },
    mcp: {
      toolName: "memory_privacy_scan",
      description:
        "Read-only privacy scan over graph Memory nodes and edges. Returns sensitive-looking findings and never writes redacted exports or graph updates.",
    },
  },
  execute: async (ctx) => {
    const records = await graphPrivacyRecords(ctx.store);
    return privacyReport("graph", records);
  },
};

const LINT_OPERATION: MemoryOperation<LintInput, LintReport> = {
  id: "memory.lint",
  title: "Memory lint",
  description: "Read-only policy hygiene lint over graph Memory records.",
  inputSchema: LintInputSchema,
  outputSchema: LintOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "lint", supportsJson: true },
    mcp: {
      toolName: "memory_lint",
      description:
        "Read-only policy hygiene lint over graph Memory nodes. Returns stale-progress, imperative-memory, missing-scope/tier, duplicate-like, and likely-secret findings.",
    },
  },
  execute: async (ctx, input) => {
    const records = (await ctx.store.listNodes()).map(graphNodeToLintRecord);
    const findings = lintMemoryRecords(records, {
      staleProgressDays: input.stale_progress_days,
    });
    return {
      status: "ok",
      mode: "graph",
      readOnly: true,
      totalMemories: records.length,
      findings,
      warnings: [],
    };
  },
};

const SKILL_RECOMMENDATIONS_OPERATION: MemoryOperation<
  SkillRecommendationsInput,
  SkillRecommendationReport
> = {
  id: "memory.skill-recommendations",
  title: "Memory skill recommendations",
  description: "Recommend RedSkills from recalled Memory evidence and skill telemetry.",
  inputSchema: SkillRecommendationsInputSchema,
  outputSchema: SkillRecommendationsOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "cache-write",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "recommend skills", supportsJson: true },
    mcp: {
      toolName: "memory_skill_recommendations",
      description:
        "Read-only RedSkills recommendations for a task from Memory evidence and skill telemetry rollups. Returns ranked recommendations, reasons, citations, and missing evidence.",
    },
  },
  execute: async (ctx, input) =>
    buildSkillRecommendations(ctx.store, input.task, {
      limit: input.limit,
      depth: input.depth,
      scope: scopeFromInput(input),
      skillRollups: await safeSkillRollups(ctx.store),
    }),
};

const LEARNING_DEBT_OPERATION: MemoryOperation<LearningDebtInput, LearningDebtReport> = {
  id: "memory.learning-debt",
  title: "Memory learning debt",
  description: "Read-only report of repeated failures, stale guidance, validation gaps, and telemetry gaps.",
  inputSchema: LearningDebtInputSchema,
  outputSchema: LearningDebtOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "learning-debt", supportsJson: true },
    mcp: {
      toolName: "memory_learning_debt",
      description:
        "Read-only learning debt report: repeated failure patterns, stale or contradicted guidance, missing validation evidence, and Skill telemetry gaps.",
    },
  },
  execute: async (ctx, input) =>
    buildLearningDebtReport(ctx.store, {
      staleDays: input.stale_days,
      minRepeatedFailures: input.min_repeated_failures,
      rollups: await safeSkillRollups(ctx.store),
      skillTelemetryEnabled: true,
    }),
};

const HEALTH_OPERATION: MemoryOperation<HealthInput, MemoryHealthReport> = {
  id: "memory.health",
  title: "Memory health",
  description: "Read-only graph health summary for MCP agents.",
  inputSchema: HealthInputSchema,
  outputSchema: HealthOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "none",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "health", supportsJson: true },
    mcp: {
      toolName: "memory_health",
      description:
        "Read-only Memory health summary for MCP agents. Returns graph stats, vector readiness, stale-node diagnostics, Skill telemetry availability, and recommended next actions.",
    },
  },
  execute: (ctx, input) => buildMemoryHealthReport(ctx.store, input),
};

const COMMUNITIES_OPERATION: MemoryOperation<CommunitiesInput, CommunityAnalyticsReport> = {
  id: "memory.communities",
  title: "Memory communities",
  description: "Read-only Memory graph community analytics.",
  inputSchema: CommunitiesInputSchema,
  outputSchema: CommunitiesOutputSchema,
  safetyClass: "read-only",
  sideEffectClass: "cache-write",
  capabilities: ["graph-store"],
  renderer: {
    cli: { command: "communities", supportsJson: true },
    mcp: {
      toolName: "memory_communities",
      description:
        "Read-only Memory graph community analytics: native Louvain assignments, community counts, top labels/titles, and graph-hash cache metadata. Does not write derived clusters into Memory graph evidence.",
    },
  },
  execute: (ctx, input) => buildCommunityAnalytics(ctx.store, { cache: input.cache }),
};

const READ_ONLY_OPERATIONS = createReadOnlyMemoryOperationRegistry([
  ASK_OPERATION,
  CLAIM_CHECK_OPERATION,
  COMMUNITIES_OPERATION,
  CONTEXT_PACK_OPERATION,
  HEALTH_OPERATION,
  LEARNING_DEBT_OPERATION,
  LINT_OPERATION,
  PRIVACY_OPERATION,
  PROVENANCE_OPERATION,
  READINESS_OPERATION,
  SKILL_RECOMMENDATIONS_OPERATION,
]);

export function createReadOnlyMemoryOperationRegistry(
  operations: readonly MemoryOperation<any, any>[],
): ReadOnlyMemoryOperationRegistry {
  const byId = new Map<string, ReadOnlyMemoryOperation>();
  for (const operation of operations) {
    assertReadOnlyOperation(operation);
    if (byId.has(operation.id)) throw new Error(`duplicate Memory operation: ${operation.id}`);
    byId.set(operation.id, operation);
  }

  return {
    list: () => [...byId.values()],
    get: (id) => {
      const operation = byId.get(id);
      if (!operation) throw new Error(`unknown read-only Memory operation: ${id}`);
      return operation;
    },
    execute: async (id, ctx, input) => {
      const operation = byId.get(id);
      if (!operation) throw new Error(`unknown read-only Memory operation: ${id}`);
      const parsedInput = operation.inputSchema.parse(input);
      const output = await operation.execute(ctx, parsedInput);
      return operation.outputSchema.parse(output);
    },
  };
}

export function listReadOnlyMemoryOperations(): ReadOnlyMemoryOperation[] {
  return READ_ONLY_OPERATIONS.list();
}

export function getReadOnlyMemoryOperation(id: string): ReadOnlyMemoryOperation {
  return READ_ONLY_OPERATIONS.get(id);
}

export async function executeReadOnlyMemoryOperation(
  id: string,
  ctx: MemoryOperationContext,
  input: unknown,
): Promise<unknown> {
  return READ_ONLY_OPERATIONS.execute(id, ctx, input);
}

function assertReadOnlyOperation(
  operation: MemoryOperation<unknown, unknown>,
): asserts operation is ReadOnlyMemoryOperation {
  if (operation.safetyClass !== "read-only") {
    throw new Error(`Memory operation ${operation.id} is not read-only`);
  }
  if (operation.sideEffectClass === "writes-memory") {
    throw new Error(`Memory operation ${operation.id} writes memory and cannot be read-only`);
  }
}

function objectOutputSchema<T>(): z.ZodType<T> {
  return z.custom<T>((value) => value !== null && typeof value === "object");
}

function scopeFromInput(input: {
  scope?: MemoryScope;
  scope_id?: string;
  include_narrower_scopes?: boolean;
}):
  | {
      level: MemoryScope;
      id?: string;
      includeNarrower?: boolean;
    }
  | undefined {
  if (!input.scope) return undefined;
  return {
    level: input.scope,
    id: input.scope_id,
    includeNarrower: input.include_narrower_scopes,
  };
}

async function safeSkillRollups(store: MemoryStore): Promise<SkillRollup[]> {
  try {
    return await readSkillRollups(store);
  } catch {
    return [];
  }
}

async function graphPrivacyRecords(store: MemoryStore): Promise<PrivacyMemoryRecord[]> {
  const [nodes, edges] = await Promise.all([store.listNodes(), store.listEdges()]);
  return [
    ...nodes.map((node) => ({
      id: `memory_nodes:${node.rid}`,
      location: `memory_nodes:${node.rid}`,
      fields: {
        label: node.label,
        node_type: node.node_type,
        ...node.properties,
      },
    })),
    ...edges.map((edge) => ({
      id: `memory_edges:${String(edge.rid ?? "unknown")}`,
      location: `memory_edges:${String(edge.rid ?? "unknown")}`,
      fields: edge,
    })),
  ];
}

function graphNodeToLintRecord(node: StoredNode): LintMemoryRecord {
  const props = node.properties;
  return {
    id: `memory_nodes:${node.rid}`,
    location: `memory_nodes:${node.rid}`,
    title: String(props.title ?? node.label),
    body: String(props.content ?? props.summary ?? props.title ?? node.label),
    scope: parseScope(props.scope),
    tier: parseTier(props.tier),
    createdAt: parseTime(props.created_at),
    updatedAt: parseTime(props.updated_at),
  };
}

function parseScope(value: unknown): MemoryScope | undefined {
  return MEMORY_SCOPES.includes(value as MemoryScope) ? (value as MemoryScope) : undefined;
}

function parseTier(value: unknown): Tier | undefined {
  return value === "durable" || value === "ephemeral" || value === "reasoning"
    ? value
    : undefined;
}

function parseTime(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function buildMemoryHealthReport(
  store: MemoryStore,
  input: HealthInput,
): Promise<MemoryHealthReport> {
  const [stats, vector, stale, rollups] = await Promise.all([
    store.stats(),
    vectorHealth(store),
    diagnose(store, { staleDays: input.stale_days }),
    skillTelemetryHealth(store),
  ]);
  const actions = healthActions(vector, stale, rollups);
  return {
    state:
      vector.overall === "failed" || rollups.status === "unavailable"
        ? "degraded"
        : actions.length > 0
          ? "attention"
          : "ready",
    read_only: true,
    stats,
    vector,
    stale: {
      total: stale.totalNodes,
      stale: stale.stale.length,
    },
    skill_telemetry: rollups,
    recommended_next_actions:
      actions.length > 0 ? actions : ["memory graph is ready for agent use"],
  };
}

async function vectorHealth(store: MemoryStore): Promise<MemoryHealthReport["vector"]> {
  try {
    const vector = await store.vectorStatus();
    return {
      overall: vector.overall,
      total: vector.total,
      ready: vector.ready,
      stale: vector.stale,
      unavailable: vector.unavailable,
      failed: vector.failed,
    };
  } catch (err) {
    return {
      overall: "unavailable",
      total: 0,
      ready: 0,
      stale: 0,
      unavailable: 0,
      failed: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function skillTelemetryHealth(
  store: MemoryStore,
): Promise<MemoryHealthReport["skill_telemetry"]> {
  try {
    return { status: "available", rollups: (await readSkillRollups(store)).length };
  } catch (err) {
    return {
      status: "unavailable",
      rollups: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function healthActions(
  vector: MemoryHealthReport["vector"],
  stale: DoctorReport,
  rollups: MemoryHealthReport["skill_telemetry"],
): string[] {
  const actions: string[] = [];
  if (vector.overall === "stale" || vector.stale > 0) {
    actions.push("refresh vector projections before relying on semantic recall");
  }
  if (vector.overall === "failed" || vector.failed > 0) {
    actions.push("repair failed vector projections");
  }
  if (stale.stale.length > 0) {
    actions.push("review stale Memory nodes before using old guidance");
  }
  if (rollups.status === "unavailable" || rollups.rollups === 0) {
    actions.push("collect Skill telemetry before relying on skill evolution signals");
  }
  return actions;
}
