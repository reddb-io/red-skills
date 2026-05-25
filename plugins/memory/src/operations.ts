import { z } from "zod";
import {
  buildCommunityAnalytics,
  type CommunityAnalyticsReport,
  type CommunityCacheMode,
} from "./communities.js";
import type { MemoryStore } from "./graph-store.js";

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

const READ_ONLY_OPERATIONS = createReadOnlyMemoryOperationRegistry([COMMUNITIES_OPERATION]);

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
