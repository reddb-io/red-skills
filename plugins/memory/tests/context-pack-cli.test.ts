import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

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
    },
    TIMEOUT,
  );
});
