import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { extractCode } from "../src/extract-code.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TS_FIXTURE = join(HERE, "fixtures/repo/src/auth.ts");
const IMPORT_FIXTURE = join(HERE, "fixtures/imports/src/app.ts");
const IMPORT_LOCAL_FIXTURE = join(HERE, "fixtures/imports/src/local.ts");

describe("extractCode", () => {
  test("extracts a file node plus one symbol per top-level declaration", async () => {
    const { nodes } = await extractCode(TS_FIXTURE);

    const file = nodes.find((n) => n.node_type === "file");
    expect(file?.label).toBe(`file:${TS_FIXTURE}`);
    expect(file?.properties.language).toBe("typescript");
    expect(file?.properties.confidence).toBe("EXTRACTED");

    const byTitle = (title: string) =>
      nodes.find((n) => n.node_type === "symbol" && n.properties.title === title);

    expect(byTitle("Session")?.properties.summary).toBe("interface");
    expect(byTitle("UserId")?.properties.summary).toBe("type");
    expect(byTitle("TokenStore")?.properties.summary).toBe("class");
    expect(byTitle("issueToken")?.properties.summary).toBe("function");
    expect(byTitle("verifyToken")?.properties.summary).toBe("const");

    const symbols = nodes.filter((n) => n.node_type === "symbol");
    expect(symbols).toHaveLength(5);
  });

  test("captures exported names on the file node for the graph contract", async () => {
    const { nodes } = await extractCode(TS_FIXTURE);
    const file = nodes.find((n) => n.node_type === "file");
    expect(file?.properties.exports).toEqual(
      expect.arrayContaining(["Session", "UserId", "TokenStore", "issueToken", "verifyToken"]),
    );
  });

  test("emits a DEFINED_IN edge from every symbol to its file", async () => {
    const { nodes, edges } = await extractCode(TS_FIXTURE);
    const fileNode = nodes.find((n) => n.node_type === "file");
    const symbols = nodes.filter((n) => n.node_type === "symbol");
    const definedIn = edges.filter((e) => e.label === "DEFINED_IN");

    expect(definedIn).toHaveLength(symbols.length);
    for (const e of definedIn) {
      expect(e.label).toBe("DEFINED_IN");
      expect(e.toLabel).toBe(fileNode?.label);
    }
  });

  test("emits conservative intra-file CALLS edges for TS/JS symbols", async () => {
    const { edges } = await extractCode(TS_FIXTURE);

    expect(edges).toContainEqual(
      expect.objectContaining({
        fromLabel: `sym:${TS_FIXTURE}#issueToken`,
        toLabel: `sym:${TS_FIXTURE}#verifyToken`,
        label: "CALLS",
      }),
    );
  });

  test("emits conservative intra-file USES_TYPE edges for TS/JS symbols", async () => {
    const { edges } = await extractCode(TS_FIXTURE);

    expect(edges).toContainEqual(
      expect.objectContaining({
        fromLabel: `sym:${TS_FIXTURE}#issueToken`,
        toLabel: `sym:${TS_FIXTURE}#UserId`,
        label: "USES_TYPE",
      }),
    );
  });

  test("uses compiler-backed TypeScript extraction with locations and edge metadata", async () => {
    const { nodes, edges } = await extractCode(TS_FIXTURE);

    const file = nodes.find((n) => n.node_type === "file");
    const issueToken = nodes.find((n) => n.label === `sym:${TS_FIXTURE}#issueToken`);
    const call = edges.find((e) => e.label === "CALLS");

    expect(file?.properties.extraction_backend).toBe("typescript-compiler");
    expect(issueToken?.properties.source_location).toMatch(/auth\.ts:\d+:\d+$/);
    expect(call).toEqual(
      expect.objectContaining({
        weight: expect.any(Number),
        properties: expect.objectContaining({
          confidence: "EXTRACTED",
          extraction_backend: "typescript-compiler",
          topological_weight: expect.any(Number),
          provenance: expect.objectContaining({
            source_kind: "derived",
            writer: "extract-code",
            confidence: "EXTRACTED",
          }),
        }),
      }),
    );
  });

  test("marks TypeScript extraction as degraded when compiler extraction is unavailable", async () => {
    const { nodes, edges } = await extractCode(TS_FIXTURE, {
      loadTypeScript: async () => null,
    });

    const file = nodes.find((n) => n.node_type === "file");
    const call = edges.find((e) => e.label === "CALLS");

    expect(file?.properties.extraction_backend).toBe("regex-fallback");
    expect(file?.properties.extraction_degraded).toBe(true);
    expect(file?.properties.extraction_degradation_reason).toBe(
      "typescript compiler unavailable",
    );
    expect(call?.properties?.extraction_backend).toBe("regex-fallback");
  });

  test("emits IMPORTS edges from the file node to import specifier nodes", async () => {
    const { nodes, edges } = await extractCode(IMPORT_FIXTURE);
    const fileNode = nodes.find((n) => n.node_type === "file");
    const imports = nodes.filter((n) => n.node_type === "import");

    expect(imports.map((n) => n.properties.title)).toEqual(["node:path", "./local.js"]);
    expect(imports.find((n) => n.properties.title === "node:path")?.properties.import_kind).toBe(
      "bare",
    );
    expect(
      imports.find((n) => n.properties.title === "./local.js")?.properties.resolved_path,
    ).toBe(
      join(HERE, "fixtures/imports/src/local.js"),
    );

    const importEdges = edges.filter((e) => e.label === "IMPORTS");
    expect(importEdges).toHaveLength(2);
    for (const edge of importEdges) {
      expect(edge.fromLabel).toBe(fileNode?.label);
      expect(imports.some((n) => n.label === edge.toLabel)).toBe(true);
    }
  });

  test("emits compiler-resolved cross-file CALLS and USES_TYPE edges", async () => {
    const { nodes, edges } = await extractCode(IMPORT_FIXTURE);

    expect(nodes).toContainEqual(
      expect.objectContaining({
        label: `sym:${IMPORT_LOCAL_FIXTURE}#localValue`,
        node_type: "symbol",
        properties: expect.objectContaining({
          title: "localValue",
          source_location: expect.stringContaining(`${IMPORT_LOCAL_FIXTURE}:`),
          extraction_backend: "typescript-compiler",
        }),
      }),
    );
    expect(nodes).toContainEqual(
      expect.objectContaining({
        label: `sym:${IMPORT_LOCAL_FIXTURE}#LocalOptions`,
        node_type: "symbol",
        properties: expect.objectContaining({
          title: "LocalOptions",
          source_location: expect.stringContaining(`${IMPORT_LOCAL_FIXTURE}:`),
          extraction_backend: "typescript-compiler",
        }),
      }),
    );
    expect(edges).toContainEqual(
      expect.objectContaining({
        fromLabel: `sym:${IMPORT_FIXTURE}#render`,
        toLabel: `sym:${IMPORT_LOCAL_FIXTURE}#localValue`,
        label: "CALLS",
        properties: expect.objectContaining({
          confidence: "EXTRACTED",
          extraction_backend: "typescript-compiler",
          topological_weight: expect.any(Number),
        }),
      }),
    );
    expect(edges).toContainEqual(
      expect.objectContaining({
        fromLabel: `sym:${IMPORT_FIXTURE}#render`,
        toLabel: `sym:${IMPORT_LOCAL_FIXTURE}#LocalOptions`,
        label: "USES_TYPE",
        properties: expect.objectContaining({
          confidence: "EXTRACTED",
          extraction_backend: "typescript-compiler",
          topological_weight: expect.any(Number),
        }),
      }),
    );
  });

  test("ignores unsupported file extensions", async () => {
    const result = await extractCode(join(HERE, "fixtures/repo/docs/guide.md"));
    expect(result).toEqual({ nodes: [], edges: [] });
  });
});
