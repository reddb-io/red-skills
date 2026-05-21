import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { extractCode } from "../src/extract-code.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TS_FIXTURE = join(HERE, "fixtures/repo/src/auth.ts");

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

  test("emits a DEFINED_IN edge from every symbol to its file", async () => {
    const { nodes, edges } = await extractCode(TS_FIXTURE);
    const fileNode = nodes.find((n) => n.node_type === "file");
    const symbols = nodes.filter((n) => n.node_type === "symbol");

    expect(edges).toHaveLength(symbols.length);
    for (const e of edges) {
      expect(e.label).toBe("DEFINED_IN");
      expect(e.toLabel).toBe(fileNode?.label);
    }
  });

  test("ignores unsupported file extensions", async () => {
    const result = await extractCode(join(HERE, "fixtures/repo/docs/guide.md"));
    expect(result).toEqual({ nodes: [], edges: [] });
  });
});
