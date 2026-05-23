import { describe, expect, test } from "vitest";
import { readStructuralImpact } from "../src/structural-impact-reader.js";
import type { MemoryEdge, MemoryNode } from "../src/schema.js";

const targetFile = "/repo/src/target.ts";
const consumerFile = "/repo/src/consumer.ts";

function node(rid: number, label: string, node_type: MemoryNode["node_type"], title: string): MemoryNode & { rid: number } {
  return {
    rid,
    label,
    node_type,
    properties: { title, source: title, confidence: "EXTRACTED" },
  };
}

function edge(from_rid: number, to_rid: number, label: MemoryEdge["label"]): MemoryEdge {
  return { from_rid, to_rid, label };
}

describe("readStructuralImpact", () => {
  test("returns imports, importers, definitions, and containing file for known targets", async () => {
    const target = node(1, `file:${targetFile}`, "file", targetFile);
    const dependency = node(2, `import:${targetFile}#node:path`, "import", "node:path");
    const exported = node(3, `sym:${targetFile}#renderTarget`, "symbol", "renderTarget");
    const consumer = node(4, `file:${consumerFile}`, "file", consumerFile);
    const consumerImport = {
      ...node(5, `import:${consumerFile}#./target.js`, "import", "./target.js"),
      properties: {
        title: "./target.js",
        source: consumerFile,
        confidence: "EXTRACTED" as const,
        resolved_path: targetFile,
      },
    };

    const result = await readStructuralImpact(
      {
        listNodes: async () => [target, dependency, exported, consumer, consumerImport],
        listEdges: async () => [
          edge(target.rid, dependency.rid, "IMPORTS"),
          edge(exported.rid, target.rid, "DEFINED_IN"),
          edge(consumer.rid, consumerImport.rid, "IMPORTS"),
        ],
      },
      { file: targetFile, symbol: "renderTarget" },
    );

    expect(result.imports.map((e) => e.to.label)).toEqual([dependency.label]);
    expect(result.importedBy.map((e) => e.from.label)).toEqual([consumer.label]);
    expect(result.defines.map((n) => n.label)).toEqual([exported.label]);
    expect(result.definedIn?.label).toBe(target.label);
  });

  test("returns an empty shaped result for unknown targets and empty graphs", async () => {
    const graph = {
      listNodes: async () => [],
      listEdges: async () => [],
    };

    await expect(
      readStructuralImpact(graph, { file: "/repo/src/missing.ts", symbol: "missing" }),
    ).resolves.toEqual({
      imports: [],
      importedBy: [],
      defines: [],
      definedIn: null,
    });
  });
});
