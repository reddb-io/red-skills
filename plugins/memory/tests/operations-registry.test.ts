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

  test("declares read-only contracts for agent-native readiness and trust operations", () => {
    const operations = listReadOnlyMemoryOperations();

    expect(operations.map((op) => op.id).sort()).toEqual(
      [
        "memory.ask",
        "memory.claim-check",
        "memory.communities",
        "memory.context-pack",
        "memory.health",
        "memory.learning-debt",
        "memory.lint",
        "memory.privacy-scan",
        "memory.provenance",
        "memory.readiness",
        "memory.skill-recommendations",
      ].sort(),
    );
    expect(operations.map((op) => op.renderer.mcp.toolName).sort()).toEqual(
      [
        "memory_ask",
        "memory_claim_check",
        "memory_communities",
        "memory_context_pack",
        "memory_health",
        "memory_learning_debt",
        "memory_lint",
        "memory_privacy_scan",
        "memory_provenance",
        "memory_readiness",
        "memory_skill_recommendations",
      ].sort(),
    );
    expect(operations.every((op) => op.safetyClass === "read-only")).toBe(true);
    expect(operations.map((op) => op.sideEffectClass)).not.toContain("writes-memory");
    expect(operations.map((op) => op.id)).not.toContain("memory.store");
    expect(operations.map((op) => op.id)).not.toContain("memory.supersede");

    expect(getReadOnlyMemoryOperation("memory.readiness").outputSchema.parse).toBeTypeOf(
      "function",
    );
    expect(getReadOnlyMemoryOperation("memory.ask").outputSchema.parse).toBeTypeOf("function");
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
