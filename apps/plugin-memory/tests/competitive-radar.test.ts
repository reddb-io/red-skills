import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { buildMemoryReferenceRadar } from "../src/references-radar.js";
import { MemoryStore } from "../src/graph-store.js";
import { indexFile } from "../src/ingest.js";
import { initGraph } from "../src/init.js";

const TIMEOUT = 40_000;
const pkgRoot = resolve(__dirname, "..");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memory-references-radar-"));
  roots.push(root);
  return root;
}

async function seedDoc(root: string): Promise<string> {
  const doc = join(root, "docs", "security.md");
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(
    doc,
    "# Security\n\nJWT rotation references `JWT_SECRET` and signed fixtures.\n",
    "utf8",
  );
  return doc;
}

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: pkgRoot,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

describe("Memory references radar", () => {
  test("maps capability catalog evidence to named reference axes", async () => {
    const root = await tempRoot();
    await initGraph(root, { hooks: true, skillTelemetry: true });
    const doc = await seedDoc(root);
    const store = await MemoryStore.open({ uri: `file://${join(root, ".red/memory/graph.rdb")}` });
    try {
      await indexFile(store, doc);

      const radar = await buildMemoryReferenceRadar(store, root, {
        now: 1_700_000_000_000,
      });

      expect(radar).toMatchObject({
        schema_version: "memory.reference_radar.v1",
        read_only: true,
        note: expect.stringContaining("not a public benchmark claim"),
        source_catalog: {
          schema_version: "memory.capability_catalog.v1",
        },
        summary: {
          references: 5,
        },
      });
      expect(radar.references.map((reference) => reference.id)).toEqual([
        "agentmemory",
        "neo4j-agent-memory",
        "gbrain",
        "graphify",
        "ai-memory",
      ]);

      const agentmemory = radar.references.find((item) => item.id === "agentmemory");
      expect(agentmemory?.repository).toBe("rohitg00/agentmemory");
      expect(agentmemory?.capabilities.map((item) => item.id)).toEqual(
        expect.arrayContaining(["governed-hybrid-recall", "lifecycle-hooks", "vectors"]),
      );
      expect(agentmemory?.gaps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            capability_id: "vectors",
            status: "not-configured",
            next_action: expect.stringContaining("memory vector maintain --local"),
          }),
        ]),
      );

      const graphify = radar.references.find((item) => item.id === "graphify");
      expect(graphify?.capabilities.map((item) => item.id)).toEqual(
        expect.arrayContaining(["documents", "code-graph-impact"]),
      );
      expect(radar.recommended_next_actions).toContain(
        "run `memory vector maintain --local` for local-dev vectors or configure RED_MEMORY_VECTOR_PROVIDER for provider embeddings",
      );
    } finally {
      await store.close();
    }
  });

  test(
    "CLI emits references radar JSON",
    async () => {
      const root = await tempRoot();
      await initGraph(root, { hooks: true });
      await seedDoc(root);

      const ingest = runMemory(["ingest", root, "--root", root]);
      expect(ingest.status, ingest.stderr).toBe(0);

      const result = runMemory(["references-radar", "--root", root, "--json"]);
      expect(result.status, result.stderr).toBe(0);
      const body = JSON.parse(result.stdout) as {
        schema_version: string;
        note: string;
        summary: { references: number };
        references: Array<{ id: string; repository: string; capabilities: Array<{ id: string }> }>;
      };
      expect(body.schema_version).toBe("memory.reference_radar.v1");
      expect(body.note).toContain("not a public benchmark claim");
      expect(body.summary.references).toBe(5);
      expect(body.references.find((item) => item.id === "gbrain")?.repository).toBe(
        "garrytan/gbrain",
      );
      expect(
        body.references.find((item) => item.id === "neo4j-agent-memory")?.capabilities.map(
          (capability) => capability.id,
        ),
      ).toContain("code-graph-impact");
    },
    TIMEOUT,
  );
});
