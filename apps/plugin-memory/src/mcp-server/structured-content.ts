import type { MemoryStore } from "../graph-store.js";

export async function operationStructuredContent(
  operationId: string,
  output: unknown,
  _store: MemoryStore,
): Promise<Record<string, unknown>> {
  if (isRecord(output)) return output;
  return { operation_id: operationId, result: output };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
