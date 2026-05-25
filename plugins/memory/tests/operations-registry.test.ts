import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  createReadOnlyMemoryOperationRegistry,
  executeReadOnlyMemoryOperation,
  getReadOnlyMemoryOperation,
  listReadOnlyMemoryOperations,
  type MemoryOperation,
} from "../src/operations.js";

describe("read-only Memory operations registry", () => {
  test("declares contract metadata for the communities operation", () => {
    const operation = getReadOnlyMemoryOperation("memory.communities");

    expect(operation).toMatchObject({
      id: "memory.communities",
      safetyClass: "read-only",
      sideEffectClass: "cache-write",
      capabilities: ["graph-store"],
      renderer: {
        cli: { command: "communities", supportsJson: true },
        mcp: { toolName: "memory_communities" },
      },
    });
    expect(listReadOnlyMemoryOperations().map((op) => op.id)).toContain("memory.communities");
  });

  test("validates operation input before execution", async () => {
    await expect(
      executeReadOnlyMemoryOperation(
        "memory.communities",
        { store: {} as never },
        { cache: "writes-memory" },
      ),
    ).rejects.toThrow();
  });

  test("rejects mutating operations from the read-only registry path", () => {
    const mutating = {
      id: "memory.store",
      title: "Store memory",
      description: "Persists a memory fact.",
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      safetyClass: "mutating",
      sideEffectClass: "writes-memory",
      capabilities: ["graph-store"],
      renderer: {
        cli: { command: "store", supportsJson: false },
        mcp: { toolName: "memory_store", description: "Store memory" },
      },
      execute: async () => ({}),
    } satisfies MemoryOperation<object, object>;

    expect(() => createReadOnlyMemoryOperationRegistry([mutating])).toThrow(
      /not read-only/i,
    );
  });
});
