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
    const helper = node(6, `sym:${targetFile}#helper`, "symbol", "helper");
    const caller = node(7, `sym:${consumerFile}#renderConsumer`, "symbol", "renderConsumer");
    const targetType = node(8, `sym:${targetFile}#TargetProps`, "symbol", "TargetProps");

    const result = await readStructuralImpact(
      {
        listNodes: async () => [
          target,
          dependency,
          exported,
          consumer,
          consumerImport,
          helper,
          caller,
          targetType,
        ],
        listEdges: async () => [
          edge(target.rid, dependency.rid, "IMPORTS"),
          edge(exported.rid, target.rid, "DEFINED_IN"),
          edge(helper.rid, target.rid, "DEFINED_IN"),
          edge(targetType.rid, target.rid, "DEFINED_IN"),
          edge(consumer.rid, consumerImport.rid, "IMPORTS"),
          edge(exported.rid, helper.rid, "CALLS"),
          edge(caller.rid, exported.rid, "CALLS"),
          edge(exported.rid, targetType.rid, "USES_TYPE"),
          edge(caller.rid, exported.rid, "USES_TYPE"),
        ],
      },
      { file: targetFile, symbol: "renderTarget" },
    );

    expect(result.imports.map((e) => e.to.label)).toEqual([dependency.label]);
    expect(result.importedBy.map((e) => e.from.label)).toEqual([consumer.label]);
    expect(result.calls.map((e) => e.to.label)).toEqual([helper.label]);
    expect(result.calledBy.map((e) => e.from.label)).toEqual([caller.label]);
    expect(result.usesTypes.map((e) => e.to.label)).toEqual([targetType.label]);
    expect(result.usedByTypes.map((e) => e.from.label)).toEqual([caller.label]);
    expect(result.references).toEqual([]);
    expect(result.referencedBy).toEqual([]);
    expect(result.defines.map((n) => n.label)).toEqual([exported.label, helper.label, targetType.label]);
    expect(result.definedIn?.label).toBe(target.label);
  });

  test("returns SQL reference edges for table and column targets", async () => {
    const schema = node(10, "file:db/schema.sql", "file", "db/schema.sql");
    const sessions = node(11, "sql:db/schema.sql#sessions", "symbol", "sessions");
    const userId = node(12, "sql:db/schema.sql#sessions.user_id", "symbol", "sessions.user_id");
    const users = node(13, "sql:db/schema.sql#users", "symbol", "users");

    const graph = {
      listNodes: async () => [schema, sessions, userId, users],
      listEdges: async () => [
        edge(sessions.rid, schema.rid, "DEFINED_IN"),
        edge(userId.rid, schema.rid, "DEFINED_IN"),
        edge(users.rid, schema.rid, "DEFINED_IN"),
        edge(userId.rid, users.rid, "REFERENCES"),
      ],
    };

    const columnImpact = await readStructuralImpact(graph, {
      file: "db/schema.sql",
      symbol: "sessions.user_id",
    });
    expect(columnImpact.references.map((e) => e.to.label)).toEqual([users.label]);
    expect(columnImpact.referencedBy).toEqual([]);

    const tableImpact = await readStructuralImpact(graph, {
      file: "db/schema.sql",
      symbol: "users",
    });
    expect(tableImpact.references).toEqual([]);
    expect(tableImpact.referencedBy.map((e) => e.from.label)).toEqual([userId.label]);
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
      calls: [],
      calledBy: [],
      usesTypes: [],
      usedByTypes: [],
      references: [],
      referencedBy: [],
      defines: [],
      definedIn: null,
    });
  });
});
