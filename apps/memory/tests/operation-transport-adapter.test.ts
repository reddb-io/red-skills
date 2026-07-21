import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  listMemoryHttpRegistryRoutes,
  memoryHttpMethodAllowed,
  memoryOpenApiPathsForOperations,
} from "../src/http-server.js";
import {
  getReadOnlyMemoryOperation,
  createReadOnlyMemoryOperationRegistry,
  executeReadOnlyMemoryOperation,
  listReadOnlyMemoryOperations,
} from "../src/operations.js";
import type { MemoryOperationDefinition } from "../src/operations.js";
import type { MemoryStore } from "../src/graph-store.js";
import { operationStructuredContent } from "../src/mcp-server/structured-content.js";
import { renderRegistryCliReport } from "../src/cli/docs.js";
import {
  bindMemoryOperationInput,
  listMemoryOperationsForTransport,
  queryObjectFromSearchParams,
} from "../src/operation-transport-adapter.js";

describe("Memory operation transport adapter", () => {
  test("discovers a new operation only on its declared transports", () => {
    const definition = {
      id: "memory.test-registration",
      title: "Test registration",
      description: "Proves one registration owns transport discovery.",
      inputSchema: z.object({}),
      outputSchema: z.object({ status: z.literal("ok") }),
      safetyClass: "read-only",
      sideEffectClass: "none",
      capabilities: ["graph-store"],
      transports: ["cli", "http"],
      inputBinding: { fields: [] },
      outputKind: { kind: "report", format: "json" },
      renderer: {
        cli: { command: "test-registration", supportsJson: true },
        mcp: { toolName: "memory_test_registration" },
        http: {
          route: "/api/registered-test",
          aliases: ["/api/registered-test-alias"],
          methods: ["GET"],
        },
      },
      execute: async () => ({ status: "ok" as const }),
    } satisfies MemoryOperationDefinition<object, { status: "ok" }>;
    const operation = createReadOnlyMemoryOperationRegistry([definition]).get(definition.id);

    expect(listMemoryOperationsForTransport([operation], "cli")).toEqual([operation]);
    expect(listMemoryOperationsForTransport([operation], "http")).toEqual([operation]);
    expect(listMemoryOperationsForTransport([operation], "mcp")).toEqual([]);
    expect(listMemoryHttpRegistryRoutes([operation])).toEqual([
      { route: "/api/registered-test", operationId: definition.id },
      { route: "/api/registered-test-alias", operationId: definition.id },
    ]);
    expect(memoryOpenApiPathsForOperations([operation])).toEqual({
      "/api/registered-test": {
        get: {
          summary: definition.description,
          parameters: [],
          responses: {
            "200": {
              description: definition.description,
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
      "/api/registered-test-alias": {
        get: {
          summary: definition.description,
          parameters: [],
          responses: {
            "200": {
              description: definition.description,
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
    });
  });

  test("uses a report's typed output as MCP structured content", async () => {
    const output = {
      version: "2.0.0",
      stats: { node_count: 2, edge_count: 1 },
      nodes: [{ id: 1, type: "file" }],
    };

    await expect(
      operationStructuredContent("memory.map-contract", output, {} as MemoryStore),
    ).resolves.toEqual(output);
  });

  test("enforces registered HTTP methods and only treats HEAD as a GET alias", () => {
    const operation = getReadOnlyMemoryOperation("memory.whatif");
    const postOnly = {
      ...operation,
      renderer: {
        ...operation.renderer,
        http: { ...operation.renderer.http, methods: ["POST"] as const },
      },
    };

    expect(memoryHttpMethodAllowed(postOnly, "POST")).toBe(true);
    expect(memoryHttpMethodAllowed(postOnly, "GET")).toBe(false);
    expect(memoryHttpMethodAllowed(postOnly, "HEAD")).toBe(false);
    expect(memoryHttpMethodAllowed(operation, "HEAD")).toBe(true);
  });

  test("publishes registered POST input types and required fields in OpenAPI", () => {
    const definition = {
      id: "memory.test-post-registration",
      title: "Test POST registration",
      description: "Proves POST schema ownership.",
      inputSchema: z.object({
        changes: z.array(z.object({ kind: z.string() })),
        limit: z.number().optional(),
      }),
      outputSchema: z.object({ status: z.literal("ok") }),
      safetyClass: "read-only",
      sideEffectClass: "none",
      capabilities: ["graph-store"],
      transports: ["http"],
      inputBinding: {
        fields: [
          { field: "changes", sources: ["query"], type: "object-array", required: true },
          { field: "limit", sources: ["query"], type: "number" },
        ],
      },
      outputKind: { kind: "report", format: "json" },
      renderer: {
        cli: { command: "test-post-registration", supportsJson: true },
        mcp: { toolName: "memory_test_post_registration" },
        http: { route: "/api/registered-post-test", methods: ["POST"] },
      },
      execute: async () => ({ status: "ok" as const }),
    } satisfies MemoryOperationDefinition<
      { changes: Array<{ kind: string }>; limit?: number },
      { status: "ok" }
    >;
    const operation = createReadOnlyMemoryOperationRegistry([definition]).get(definition.id);

    expect(memoryOpenApiPathsForOperations([operation])).toMatchObject({
      "/api/registered-post-test": {
        post: {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    changes: { type: "array", items: { type: "object" } },
                    limit: { type: "number" },
                  },
                  required: ["changes"],
                  additionalProperties: false,
                },
              },
            },
          },
        },
      },
    });
  });

  test("renders a registered markdown report from its typed output", () => {
    const operation = {
      ...getReadOnlyMemoryOperation("memory.structural-impact"),
      outputKind: { kind: "report", format: "markdown" } as const,
    };

    expect(renderRegistryCliReport(operation, { markdown: "# Impact\n\nSafe.\n" }, false)).toBe(
      "# Impact\n\nSafe.\n",
    );
  });

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
      route: "/api/map-contract",
      operationId: "memory.map-contract",
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
        id: "memory.map-contract",
        command: "map-contract",
        outputKind: "report",
        fields: expect.arrayContaining(["communities"]),
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

  test("map-contract returns representative RedDB graph contract data", async () => {
    const store = {
      listNodes: async () => [
        {
          rid: 1,
          label: "file:/repo/src/auth.ts",
          node_type: "file",
          properties: {
            title: "src/auth.ts",
            confidence: "EXTRACTED",
            source_location: "src/auth.ts",
            provenance: { source_kind: "derived", writer: "memory ingest" },
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_100_000,
            salience: 0.8,
          },
        },
        {
          rid: 2,
          label: "sym:/repo/src/auth.ts#issueToken",
          node_type: "symbol",
          properties: { title: "issueToken" },
        },
      ],
      listEdges: async () => [
        {
          rid: 10,
          label: "DEFINED_IN",
          from: 2,
          to: 1,
          weight: 2.5,
          properties: {
            salience: 0.7,
            confidence: "EXTRACTED",
            source: "src/auth.ts:1",
            provenance: { source_kind: "derived", evidence: ["src/auth.ts:1"] },
            created_at: 1_700_000_200_000,
          },
        },
      ],
      communities: async () => new Map([[1, "c0"], [2, "c0"]]),
    } as Partial<MemoryStore> as MemoryStore;

    const contract = (await executeReadOnlyMemoryOperation(
      "memory.map-contract",
      { store },
      { communities: true },
    )) as Record<string, any>;

    expect(contract).toMatchObject({
      version: "2.0.0",
      stats: {
        node_count: 2,
        edge_count: 1,
        edge_kinds: { imports: 0, defines: 1, references: 0 },
      },
    });
    expect(contract.nodes[0]).toMatchObject({
      id: 1,
      type: "file",
      community: "c0",
      confidence: "EXTRACTED",
      source_location: "src/auth.ts",
      provenance: { source_kind: "derived", writer: "memory ingest" },
      freshness: { created_at: 1_700_000_000_000, updated_at: 1_700_000_100_000 },
      salience: 0.8,
    });
    expect(contract.edges[0]).toMatchObject({
      source: 1,
      target: 2,
      kind: "defines",
      weight: 2.5,
      salience: 0.7,
      confidence: "EXTRACTED",
      source_location: "src/auth.ts:1",
      provenance: { source_kind: "derived", evidence: ["src/auth.ts:1"] },
      freshness: { created_at: 1_700_000_200_000, updated_at: null },
      direction: "directed",
    });
    expect(contract.edges[0]).not.toHaveProperty("layout");
    expect(contract.edges[0]).not.toHaveProperty("opacity");
  });
});
