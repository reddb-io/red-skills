import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";
import { initGraph } from "../src/init.js";

const TIMEOUT = 40_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");

const roots: string[] = [];
const stores: MemoryStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: PLUGIN_ROOT,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

async function seedRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memory-code-drift-cli-"));
  roots.push(root);
  const { storeUri } = await initGraph(root);
  const store = await MemoryStore.open({ uri: storeUri, project: "test" });
  stores.push(store);

  const codes = [
    "footgun",
    "footgun",
    "footgun",
    "smell",
    "smell",
    "yak-shave",
    "decision",
    "gotcha",
  ];
  let i = 0;
  for (const code of codes) {
    await store.upsertNode({
      label: `concept:n${i}`,
      node_type: "concept",
      properties: { title: `n${i}`, engineering_code: code },
    });
    i += 1;
  }

  await store.close();
  stores.pop();
  return root;
}

describe("memory code-drift CLI (ADR 0035, #307)", () => {
  test(
    "reports unknown codes grouped by recurrence count as JSON",
    async () => {
      const root = await seedRoot();
      const result = runMemory(["code-drift", "--root", root, "--json"]);
      expect(result.status).toBe(0);
      const report = JSON.parse(result.stdout);

      expect(report.knownCount).toBe(2);
      expect(report.distinctUnknown).toBe(3);
      expect(report.groups).toEqual([
        { count: 3, recurrence: "recurring", codes: ["footgun"] },
        { count: 2, recurrence: "recurring", codes: ["smell"] },
        { count: 1, recurrence: "one-off", codes: ["yak-shave"] },
      ]);
      expect(report.recurring.map((entry: { code: string }) => entry.code)).toEqual([
        "footgun",
        "smell",
      ]);
      expect(report.oneOff.map((entry: { code: string }) => entry.code)).toEqual(["yak-shave"]);
    },
    TIMEOUT,
  );

  test(
    "code-curate promotes recurring codes and aliases synonyms for drift and recall",
    async () => {
      const root = await seedRoot();

      const promote = runMemory(["code-curate", "promote", "smell", "--root", root, "--json"]);
      expect(promote.status).toBe(0);
      const promoted = JSON.parse(promote.stdout);
      expect(promoted.changed).toBe(true);
      expect(promoted.promoted).toEqual(["smell"]);

      const alias = runMemory([
        "code-curate",
        "alias",
        "footgun",
        "gotcha",
        "--root",
        root,
        "--json",
      ]);
      expect(alias.status).toBe(0);
      const aliased = JSON.parse(alias.stdout);
      expect(aliased.aliases).toEqual([{ from: "footgun", to: "gotcha" }]);

      const drift = runMemory(["code-drift", "--root", root, "--json"]);
      expect(drift.status).toBe(0);
      const report = JSON.parse(drift.stdout);
      expect(report.knownCount).toBe(7);
      expect(report.entries).toEqual([{ code: "yak-shave", count: 1, recurrence: "one-off" }]);

      const recall = runMemory(["recall", "gotcha", "--root", root]);
      expect(recall.status).toBe(0);
      expect(recall.stdout).toContain("concept:n0");
    },
    TIMEOUT,
  );

  test(
    "human-readable output distinguishes recurring from one-off",
    async () => {
      const root = await seedRoot();
      const result = runMemory(["code-drift", "--root", root]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("3 unknown code(s)");
      expect(result.stdout).toContain("promotion/alias candidates");
      expect(result.stdout).toContain("count 3: footgun");
      expect(result.stdout).toContain("one-off");
      expect(result.stdout).toContain("count 1: yak-shave");
    },
    TIMEOUT,
  );

  test(
    "is read-only: it mutates no nodes and excludes nothing from recall",
    async () => {
      const root = await seedRoot();
      const before = runMemory(["stats", "--root", root]);
      const drift = runMemory(["code-drift", "--root", root, "--json"]);
      const recall = runMemory(["recall", "footgun", "--root", root, "--json"]);
      const after = runMemory(["stats", "--root", root]);

      expect(drift.status).toBe(0);
      expect(recall.status).toBe(0);
      expect(after.stdout).toBe(before.stdout);
    },
    TIMEOUT,
  );

  test(
    "an empty graph reports nothing to curate",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "memory-code-drift-cli-empty-"));
      roots.push(root);
      await initGraph(root);
      const result = runMemory(["code-drift", "--root", root]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("nothing to curate");
    },
    TIMEOUT,
  );
});
