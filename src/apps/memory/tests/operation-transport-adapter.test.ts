import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { listMemoryHttpRegistryRoutes } from "../src/http-server.js";
import {
  getReadOnlyMemoryOperation,
  listReadOnlyMemoryOperations,
} from "../src/operations.js";
import {
  bindMemoryOperationInput,
  queryObjectFromSearchParams,
} from "../src/operation-transport-adapter.js";

describe("Memory operation transport adapter", () => {
  test("binds doc brief CLI argv from registry input facets", () => {
    const operation = getReadOnlyMemoryOperation("memory.doc-brief");

    expect(
      bindMemoryOperationInput(operation, {
        positional: ["jwt", "rotation"],
        flags: { limit: "2", "max-bytes": "160" },
        query: {},
      }),
    ).toEqual({
      query: "jwt rotation",
      limit: 2,
      max_bytes: 160,
    });
  });

  test("binds doc brief HTTP query params from registry input facets", () => {
    const operation = getReadOnlyMemoryOperation("memory.doc-brief");
    const query = queryObjectFromSearchParams(
      new URLSearchParams("q=jwt%20fixtures&limit=2&max_bytes=160"),
    );

    expect(
      bindMemoryOperationInput(operation, {
        positional: [],
        flags: {},
        query,
      }),
    ).toEqual({
      query: "jwt fixtures",
      limit: 2,
      max_bytes: 160,
    });
  });

  test("declares doc brief viewer default file sink in the output facet", () => {
    const operation = getReadOnlyMemoryOperation("memory.doc-brief-viewer");
    const query = "jwt rotation";
    const rootDir = "/tmp/memory-root";
    const safeName = createHash("sha256").update(query).digest("hex").slice(0, 12);

    expect(operation.outputKind).toMatchObject({
      kind: "viewer",
      artifact: "self-contained-html",
      fileSink: {
        field: "out",
        sources: ["flag", "query"],
        customBind: { id: "doc-brief-viewer-output-path" },
      },
    });
    expect(
      operation.outputKind.kind === "viewer"
        ? operation.outputKind.fileSink?.customBind?.bind({
            positional: ["jwt", "rotation"],
            flags: {},
            query: {},
            rootDir,
          })
        : undefined,
    ).toBe(join(rootDir, `.red/memory/doc-brief-${safeName}.html`));
  });

  test("builds generic HTTP routes for every non-infra read-only registry operation", () => {
    const routes = listMemoryHttpRegistryRoutes();
    const operationIds = new Set(routes.map((route) => route.operationId));
    const excludedInfraOperations = new Set(["memory.workbench"]);

    for (const operation of listReadOnlyMemoryOperations()) {
      if (excludedInfraOperations.has(operation.id)) continue;
      expect(operationIds.has(operation.id), operation.id).toBe(true);
    }

    expect(routes).toContainEqual({
      route: "/api/docs/brief",
      operationId: "memory.doc-brief",
    });
    expect(routes).toContainEqual({
      route: "/docs/brief",
      operationId: "memory.doc-brief-viewer",
    });
    expect(routes).toContainEqual({
      route: "/api/context-pack",
      operationId: "memory.context-pack",
    });
    expect(routes).toContainEqual({
      route: "/memory/health",
      operationId: "memory.health-viewer",
    });
    expect(operationIds.has("memory.workbench")).toBe(false);
  });

  test("declares one generic CLI command surface for every read-only registry operation", () => {
    const commands = listReadOnlyMemoryOperations().map((operation) => ({
      id: operation.id,
      command: operation.renderer.cli.command,
      outputKind: operation.outputKind.kind,
      fields: operation.inputBinding.fields.map((field) => field.field),
    }));

    expect(commands.every((entry) => entry.command.length > 0)).toBe(true);
    expect(new Set(commands.map((entry) => entry.command)).size).toBe(commands.length);
    expect(commands.filter((entry) => entry.outputKind === "viewer").length).toBeGreaterThan(10);
    expect(commands).toContainEqual(
      expect.objectContaining({
        id: "memory.context-pack",
        command: "context-pack",
        fields: expect.arrayContaining(["goal", "budget_chars"]),
      }),
    );
    expect(commands).toContainEqual(
      expect.objectContaining({
        id: "memory.vector-status-viewer",
        command: "vector status-viewer",
        outputKind: "viewer",
      }),
    );
  });
});
