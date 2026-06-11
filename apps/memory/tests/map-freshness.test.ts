import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";
import { GRAPH_CONTRACT_VERSION } from "../src/graph-contract.js";
import { initGraph } from "../src/init.js";
import { refreshFiles } from "../src/ingest.js";
import { buildMemoryMapFreshnessReport } from "../src/map-freshness.js";

const TIMEOUT = 40_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");

const roots: string[] = [];
const stores: MemoryStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function graphRoot(): Promise<{ root: string; store: MemoryStore; file: string }> {
  const root = await mkdtemp(join(tmpdir(), "memory-map-freshness-"));
  roots.push(root);
  const { storeUri } = await initGraph(root);
  const store = await MemoryStore.open({ uri: storeUri, project: "test" });
  stores.push(store);
  const file = join(root, "src/session.ts");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, "export function startSession() { return true; }\n", "utf8");
  await refreshFiles(store, [file], { rootDir: root });
  return { root, store, file };
}

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: PLUGIN_ROOT,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

describe("Memory map freshness report", () => {
  test("reports freshness identity, source input status, coverage, and missing relationships", async () => {
    const { root, store } = await graphRoot();
    await store.upsertNode({
      label: "manual-ambiguous-note",
      node_type: "concept",
      properties: {
        title: "Manual ambiguous note",
        content: "A weak relationship should be checked in source.",
        confidence: "AMBIGUOUS",
        source: "manual",
      },
    });

    const report = await buildMemoryMapFreshnessReport(store, root, { now: 1_700_000_000_000 });

    expect(report).toMatchObject({
      schema_version: "memory.map_freshness.v1",
      read_only: true,
      status: "use-map",
      freshness_identity: {
        graph_contract_version: GRAPH_CONTRACT_VERSION,
      },
      source_inputs: {
        total: 1,
        fresh: 1,
        changed: 0,
        stale: 0,
      },
    });
    expect(report.freshness_identity.extraction_schema_version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(report.freshness_identity.extractor_versions["extract-code"]).toBe(
      report.freshness_identity.extraction_schema_version,
    );
    expect(report.extraction_coverage.by_language.typescript).toBeGreaterThan(0);
    expect(report.extraction_coverage.extractor_writers["extract-code"]).toBeGreaterThan(0);
    expect(report.relationships.by_contract_kind.defines).toBeGreaterThan(0);
    expect(report.relationships.missing_contract_kinds).toContain("references");
    expect(report.relationships.low_confidence_nodes.AMBIGUOUS).toBe(1);
    expect(report.recommended_next_actions.join("\n")).toContain("relationship coverage missing");
    expect(report.markdown).toContain("# Memory map freshness");
  });

  test("identifies changed and stale source inputs from the refresh manifest", async () => {
    const { root, store, file } = await graphRoot();

    await writeFile(file, "export function startSession() { return false; }\n", "utf8");
    const changed = await buildMemoryMapFreshnessReport(store, root);

    expect(changed.status).toBe("refresh-map");
    expect(changed.source_inputs.changed).toBe(1);
    expect(changed.source_inputs.changed_files).toEqual(["src/session.ts"]);
    expect(changed.recommended_next_actions.join("\n")).toContain("memory refresh");

    await unlink(file);
    const stale = await buildMemoryMapFreshnessReport(store, root);

    expect(stale.status).toBe("refresh-map");
    expect(stale.source_inputs.stale).toBe(1);
    expect(stale.source_inputs.stale_files).toEqual(["src/session.ts"]);
  });

  test(
    "CLI reports map freshness as JSON",
    async () => {
      const { root, store } = await graphRoot();
      await store.close();
      stores.pop();

      const result = runMemory(["map", "freshness", "--root", resolve(root), "--json"]);

      expect(result.status, result.stderr).toBe(0);
      const body = JSON.parse(result.stdout);
      expect(body).toMatchObject({
        schema_version: "memory.map_freshness.v1",
        read_only: true,
        status: "use-map",
        source_inputs: {
          fresh: 1,
        },
      });
      expect(body.markdown).toContain("## Next actions");
    },
    TIMEOUT,
  );
});
