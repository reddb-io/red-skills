import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";
import { initGraph } from "../src/init.js";
import { buildStructuralImpactViewerArtifact } from "../src/structural-impact-viewer.js";
import type { MemoryNode } from "../src/schema.js";
import type { StructuralImpact } from "../src/structural-impact-reader.js";

const TIMEOUT = 40_000;
const pkgRoot = resolve(__dirname, "..");
const roots: string[] = [];
const stores: MemoryStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: pkgRoot,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

function node(rid: number, label: string, title: string): MemoryNode & { rid: number } {
  return {
    rid,
    label,
    node_type: label.startsWith("file:") ? "file" : "symbol",
    properties: { title, source: title, confidence: "EXTRACTED" },
  };
}

describe("structural impact viewer artifact", () => {
  test("renders a self-contained HTML viewer from structural impact evidence", () => {
    const file = node(1, "file:src/auth.ts", "src/auth.ts");
    const issueToken = node(2, "sym:src/auth.ts#issueToken", "issueToken");
    const verifyToken = node(3, "sym:src/auth.ts#verifyToken", "verifyToken");
    const userId = node(4, "sym:src/auth.ts#UserId", "UserId");
    const impact: StructuralImpact = {
      imports: [],
      importedBy: [],
      calls: [{ from_rid: 2, to_rid: 3, label: "CALLS", from: issueToken, to: verifyToken }],
      calledBy: [],
      usesTypes: [{ from_rid: 2, to_rid: 4, label: "USES_TYPE", from: issueToken, to: userId }],
      usedByTypes: [],
      references: [],
      referencedBy: [],
      defines: [issueToken, verifyToken, userId],
      definedIn: file,
    };

    const artifact = buildStructuralImpactViewerArtifact({ file: "src/auth.ts" }, impact);

    expect(artifact.contract).toEqual({
      name: "memory.structural_impact.viewer",
      version: "memory.structural_impact.viewer.v1",
      consumes: "memory.structural-impact",
    });
    expect(artifact.html).toContain("<!doctype html>");
    expect(artifact.html).toContain("Structural Impact");
    expect(artifact.html).toContain("Calls");
    expect(artifact.html).toContain("Uses types");
    expect(artifact.html).toContain("References");
    expect(artifact.html).toContain("issueToken");
    expect(artifact.html).toContain("UserId");
    expect(artifact.html).toContain('id="structural-impact-data"');
    expect(artifact.html).not.toContain("<script src=");
  });

  test(
    "CLI writes a local structural impact viewer from graph evidence",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "memory-structural-impact-viewer-"));
      roots.push(root);
      const { storeUri } = await initGraph(root);
      const store = await MemoryStore.open({ uri: storeUri, project: "test" });
      stores.push(store);

      const fileRid = await store.upsertNode({
        label: "file:src/auth.ts",
        node_type: "file",
        properties: { title: "src/auth.ts", source: "src/auth.ts", confidence: "EXTRACTED" },
      });
      const issueRid = await store.upsertNode({
        label: "sym:src/auth.ts#issueToken",
        node_type: "symbol",
        properties: { title: "issueToken", source: "src/auth.ts:1", confidence: "EXTRACTED" },
      });
      const verifyRid = await store.upsertNode({
        label: "sym:src/auth.ts#verifyToken",
        node_type: "symbol",
        properties: { title: "verifyToken", source: "src/auth.ts:2", confidence: "EXTRACTED" },
      });
      await store.upsertEdge({ from_rid: issueRid, to_rid: fileRid, label: "DEFINED_IN" });
      await store.upsertEdge({ from_rid: verifyRid, to_rid: fileRid, label: "DEFINED_IN" });
      await store.upsertEdge({ from_rid: issueRid, to_rid: verifyRid, label: "CALLS" });
      await store.close();
      stores.pop();

      const out = join(root, "impact.html");
      const result = runMemory([
        "structural-impact-viewer",
        "--root",
        root,
        "--file",
        "src/auth.ts",
        "--out",
        out,
      ]);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("memory: structural impact viewer written");
      expect(result.stdout).toContain(out);

      const html = await readFile(out, "utf8");
      expect(html).toContain("Structural Impact");
      expect(html).toContain("issueToken");
      expect(html).toContain("verifyToken");
      expect(html).toContain('id="structural-impact-data"');
    },
    TIMEOUT,
  );
});
