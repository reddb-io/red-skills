import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { readConfig, resolveStoreUri } from "../src/config.js";
import { MemoryStore } from "../src/graph-store.js";
import { readMemoryEvents } from "../src/memory-events.js";

const TIMEOUT = 40_000;
const pkgRoot = resolve(__dirname, "..");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: pkgRoot,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

async function initRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memory-context-pack-cli-"));
  roots.push(root);
  const init = runMemory(["init", "--mode", "graph", "--root", root, "--yes"]);
  expect(init.status, init.stderr).toBe(0);
  return root;
}

describe("memory context-pack CLI", () => {
  test(
    "builds a JSON context pack from a graph-mode goal",
    async () => {
      const root = await initRoot();
      const stored = runMemory([
        "store",
        "Decision: JWT token work must update docs/security.md and use signed fixtures.",
        "--root",
        root,
      ]);
      expect(stored.status, stored.stderr).toBe(0);

      const result = runMemory([
        "context-pack",
        "jwt token work",
        "--root",
        root,
        "--budget",
        "1200",
        "--json",
      ]);
      expect(result.status, result.stderr).toBe(0);
      const body = JSON.parse(result.stdout) as {
        status: string;
        budgetChars: number;
        usedChars: number;
        markdown: string;
        entries: Array<{ reason: string; citation: { urn: string; source: string } }>;
      };

      expect(body.status).toBe("ok");
      expect(body.usedChars).toBeLessThanOrEqual(body.budgetChars);
      expect(body.markdown).toContain("urn: memory_nodes:");
      expect(body.entries[0].reason).toContain("matched the goal");
      expect(body.entries[0].citation.source).toBe("manual");

      const config = await readConfig(root);
      if (!config) throw new Error("config missing after init");
      const store = await MemoryStore.open({ uri: resolveStoreUri(root, config) });
      try {
        const events = await readMemoryEvents(store);
        expect(events.filter((event) => event.kind === "memory.context-pack.generated")).toHaveLength(1);
        expect(events.filter((event) => event.kind === "memory.injection.delivered")).toHaveLength(0);
      } finally {
        await store.close();
      }
    },
    TIMEOUT,
  );

  test(
    "writes a self-contained context pack viewer",
    async () => {
      const root = await initRoot();
      const stored = runMemory([
        "store",
        "Decision: JWT token work must update docs/security.md and use signed fixtures.",
        "--root",
        root,
      ]);
      expect(stored.status, stored.stderr).toBe(0);

      const out = join(root, "context-pack.html");
      const result = runMemory([
        "context-pack-viewer",
        "jwt token work",
        "--root",
        root,
        "--budget",
        "1200",
        "--out",
        out,
      ]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("memory: context pack viewer written");
      const html = await readFile(out, "utf8");
      expect(html).toContain("Memory Context Pack");
      expect(html).toContain("JWT token work");
      expect(html).toContain('id="memory-context-pack-data"');
      expect(html).not.toContain("<script src=");
    },
    TIMEOUT,
  );
});
