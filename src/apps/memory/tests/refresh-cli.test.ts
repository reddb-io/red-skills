import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { initGraph } from "../src/init.js";

const TIMEOUT = 30_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");
const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-refresh-cli-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function runMemory(args: string[], input?: string) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: PLUGIN_ROOT,
    encoding: "utf8",
    input,
    timeout: TIMEOUT,
  });
}

describe("memory refresh CLI", () => {
  test(
    "refreshes stdin file paths and reports skipped graph elements on replay",
    async () => {
      const root = await tempRoot();
      await initGraph(root);
      const file = join(root, "src/session.ts");
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, "export function startSession() { return true; }\n", "utf8");

      const first = runMemory(["refresh", "--root", root, "--stdin", "--json"], `${file}\n`);
      expect(first.status).toBe(0);
      const firstBody = JSON.parse(first.stdout);
      expect(firstBody.files).toBe(1);
      expect(firstBody.added).toBeGreaterThanOrEqual(2);

      const replay = runMemory(["refresh", "--root", root, "--stdin", "--json"], `${file}\n`);
      expect(replay.status).toBe(0);
      const replayBody = JSON.parse(replay.stdout);
      expect(replayBody.files).toBe(0);
      expect(replayBody.skipped).toBe(firstBody.added);
    },
    TIMEOUT,
  );

  test(
    "allows hook-style stdin refreshes with no changed files",
    async () => {
      const root = await tempRoot();
      await initGraph(root);

      const result = runMemory(["refresh", "--root", root, "--stdin", "--json"], "");
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(
        expect.objectContaining({
          files: 0,
          added: 0,
          updated: 0,
          skipped: 0,
          stale: 0,
        }),
      );
    },
    TIMEOUT,
  );
});
