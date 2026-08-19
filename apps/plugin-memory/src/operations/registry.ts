import type {
  MemoryOperation,
  MemoryOperationContext,
  MemoryOperationDefinition,
  MemoryOperationFacets,
  MemoryOperationInputBinding,
  MemoryOperationOutputKind,
  MemoryOperationTransport,
  ReadOnlyMemoryOperation,
  ReadOnlyMemoryOperationRegistry,
} from "./types.js";
import { MEMORY_OPERATION_FACETS } from "./facets.js";
import { READ_ONLY_MEMORY_OPERATION_DEFINITIONS } from "./definitions.js";

const DEFAULT_READ_ONLY_TRANSPORTS = ["cli", "mcp", "http"] as const;
const READ_ONLY_OPERATIONS = createReadOnlyMemoryOperationRegistry(
  READ_ONLY_MEMORY_OPERATION_DEFINITIONS,
);

export function createReadOnlyMemoryOperationRegistry(
  operations: readonly MemoryOperationDefinition<any, any>[],
  facetsByOperationId: Readonly<Record<string, MemoryOperationFacets>> = MEMORY_OPERATION_FACETS,
): ReadOnlyMemoryOperationRegistry {
  const byId = new Map<string, ReadOnlyMemoryOperation>();
  for (const operation of operations) {
    const inlineFacets =
      operation.inputBinding && operation.outputKind
        ? { inputBinding: operation.inputBinding, outputKind: operation.outputKind }
        : undefined;
    const operationWithFacets = attachMemoryOperationFacets(
      operation,
      inlineFacets ?? facetsByOperationId[operation.id],
    );
    assertReadOnlyOperation(operationWithFacets);
    if (byId.has(operation.id)) throw new Error(`duplicate Memory operation: ${operation.id}`);
    byId.set(operation.id, operationWithFacets);
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

function attachMemoryOperationFacets<Input, Output>(
  operation: MemoryOperationDefinition<Input, Output>,
  facets: MemoryOperationFacets | undefined,
): MemoryOperation<Input, Output> {
  if (!facets) throw new Error(`Memory operation ${operation.id} is missing facets`);
  assertMemoryOperationFacets(operation.id, facets);
  return {
    ...operation,
    transports: validatedTransports(operation.id, operation.transports),
    inputBinding: facets.inputBinding,
    outputKind: facets.outputKind,
  };
}

function validatedTransports(
  operationId: string,
  transports: readonly MemoryOperationTransport[] | undefined,
): readonly MemoryOperationTransport[] {
  const declared = transports ?? DEFAULT_READ_ONLY_TRANSPORTS;
  if (declared.length === 0) {
    throw new Error(`Memory operation ${operationId} has no visible transports`);
  }
  if (new Set(declared).size !== declared.length) {
    throw new Error(`Memory operation ${operationId} has duplicate transports`);
  }
  for (const transport of declared) {
    if (!DEFAULT_READ_ONLY_TRANSPORTS.includes(transport)) {
      throw new Error(`Memory operation ${operationId} has invalid transport ${transport}`);
    }
  }
  return [...declared];
}

function assertMemoryOperationFacets(
  operationId: string,
  facets: MemoryOperationFacets,
): void {
  if (!facets || typeof facets !== "object") {
    throw new Error(`Memory operation ${operationId} has malformed facets`);
  }
  assertInputBinding(operationId, facets.inputBinding);
  assertOutputKind(operationId, facets.outputKind);
}

function assertInputBinding(operationId: string, inputBinding: MemoryOperationInputBinding): void {
  if (!inputBinding || !Array.isArray(inputBinding.fields)) {
    throw new Error(`Memory operation ${operationId} has malformed input binding`);
  }
  const seenFields = new Set<string>();
  for (const field of inputBinding.fields) {
    if (!field || typeof field.field !== "string" || field.field.length === 0) {
      throw new Error(`Memory operation ${operationId} has malformed input binding field`);
    }
    if (seenFields.has(field.field)) {
      throw new Error(
        `Memory operation ${operationId} has duplicate input binding field ${field.field}`,
      );
    }
    seenFields.add(field.field);
    if (!Array.isArray(field.sources) || field.sources.length === 0) {
      throw new Error(
        `Memory operation ${operationId} input binding field ${field.field} has no sources`,
      );
    }
    for (const source of field.sources) {
      if (!["positional", "flag", "query"].includes(source)) {
        throw new Error(
          `Memory operation ${operationId} input binding field ${field.field} has invalid source`,
        );
      }
    }
    if (!["string", "number", "boolean", "string-array", "object-array", "path"].includes(field.type)) {
      throw new Error(
        `Memory operation ${operationId} input binding field ${field.field} has invalid type`,
      );
    }
    if (field.position != null && (!Number.isInteger(field.position) || field.position < 0)) {
      throw new Error(
        `Memory operation ${operationId} input binding field ${field.field} has invalid position`,
      );
    }
  }
  if (inputBinding.customBind) {
    assertCustomBind(operationId, "input binding", inputBinding.customBind);
  }
}

function assertOutputKind(operationId: string, outputKind: MemoryOperationOutputKind): void {
  if (!outputKind || typeof outputKind !== "object") {
    throw new Error(`Memory operation ${operationId} has malformed output kind`);
  }
  if (outputKind.kind === "report") {
    if (!["json", "markdown"].includes(outputKind.format)) {
      throw new Error(`Memory operation ${operationId} has malformed report output kind`);
    }
    return;
  }
  if (outputKind.kind !== "viewer" || outputKind.artifact !== "self-contained-html") {
    throw new Error(`Memory operation ${operationId} has malformed output kind`);
  }
  if (!outputKind.fileSink) return;
  if (
    outputKind.fileSink.field.length === 0 ||
    outputKind.fileSink.type !== "path" ||
    !Array.isArray(outputKind.fileSink.sources) ||
    outputKind.fileSink.sources.length === 0
  ) {
    throw new Error(`Memory operation ${operationId} has malformed viewer file sink`);
  }
  for (const source of outputKind.fileSink.sources) {
    if (!["flag", "query"].includes(source)) {
      throw new Error(`Memory operation ${operationId} has malformed viewer file sink source`);
    }
  }
  if (outputKind.fileSink.customBind) {
    assertCustomBind(operationId, "viewer file sink", outputKind.fileSink.customBind);
  }
}

function assertCustomBind(
  operationId: string,
  label: string,
  customBind: { id: string; description: string; bind: (...args: any[]) => unknown },
): void {
  if (
    typeof customBind.id !== "string" ||
    customBind.id.length === 0 ||
    typeof customBind.description !== "string" ||
    customBind.description.length === 0 ||
    typeof customBind.bind !== "function"
  ) {
    throw new Error(`Memory operation ${operationId} has malformed custom ${label}`);
  }
}
