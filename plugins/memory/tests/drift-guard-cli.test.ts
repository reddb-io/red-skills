import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { readConfig, resolveStoreUri } from "../src/config.js";
import { MemoryStore } from "../src/graph-store.js";
import { initGraph } from "../src/init.js";
import { readMemoryEvents } from "../src/memory-events.js";

const TIMEOUT = 60_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");
const roots: string[] = [];

const SHA = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-drift-guard-cli-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", join(PLUGIN_ROOT, "src/cli.ts"), ...args], {
    cwd: PLUGIN_ROOT,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

/** Run drift-guard against a root, supplying changed files and head message as files. */
async function runGuard(root: string, changed: string[], headMessage: string) {
  const changedPath = join(root, "changed.txt");
  const msgPath = join(root, "head-msg.txt");
  await writeFile(changedPath, `${changed.join("\n")}\n`, "utf8");
  await writeFile(msgPath, headMessage, "utf8");
  return runMemory([
    "drift-guard",
    "--root",
    root,
    "--changed-files",
    changedPath,
    "--head-message",
    msgPath,
  ]);
}

async function readDriftEvents(root: string) {
  const config = await readConfig(root);
  if (!config) return [];
  const store = await MemoryStore.open({ uri: resolveStoreUri(root, config) });
  try {
    return (await readMemoryEvents(store)).filter((e) => e.kind === "memory.drift.caught");
  } finally {
    await store.close();
  }
}

describe("memory drift-guard CLI (#224)", () => {
  test(
    "code-only PR passes silently with no telemetry event (AC3)",
    async () => {
      const root = await tempRoot();
      await initGraph(root);
      const result = await runGuard(root, ["src/a.ts", "README.md"], "chore: tidy\n");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("no watched paths changed");
      expect(await readDriftEvents(root)).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "PR touching an ADR with a Memory-Ingested trailer passes (AC5)",
    async () => {
      const root = await tempRoot();
      await initGraph(root);
      const result = await runGuard(
        root,
        [".red/adr/0030.md"],
        `docs(adr): add 0030\n\nMemory-Ingested: ${SHA}\n`,
      );
      expect(result.status).toBe(0);
      expect(await readDriftEvents(root)).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "PR touching an ADR with an audit-log entry passes (AC5 — audit-log form)",
    async () => {
      const root = await tempRoot();
      await initGraph(root);
      await mkdir(join(root, ".red/memory"), { recursive: true });
      await writeFile(
        join(root, ".red/memory/.audit.log"),
        `2026-05-28T12:00:00Z ingest .red/adr/0031.md ${SHA}\n`,
        "utf8",
      );
      const result = await runGuard(root, [".red/adr/0031.md"], "docs(adr): add 0031\n");
      expect(result.status).toBe(0);
    },
    TIMEOUT,
  );

  test(
    "PR touching CONTEXT.md with a Memory-NoIngest bypass trailer passes (AC6)",
    async () => {
      const root = await tempRoot();
      await initGraph(root);
      const result = await runGuard(
        root,
        [".red/CONTEXT.md"],
        "fix(context): typo\n\nMemory-NoIngest: typo fix only\n",
      );
      expect(result.status).toBe(0);
    },
    TIMEOUT,
  );

  test(
    "PR touching an ADR without a marker fails with the documented line AND fires the drift event (AC4, AC7)",
    async () => {
      const root = await tempRoot();
      await initGraph(root);
      const result = await runGuard(root, ["src/a.ts", ".red/adr/0032.md"], "docs(adr): add 0032\n");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Run /memory:ingest .red/adr/0032.md and re-push (or add Memory-NoIngest: <reason> trailer).",
      );

      const drift = await readDriftEvents(root);
      expect(drift).toHaveLength(1);
      expect(drift[0].payload).toMatchObject({
        event_type: "memory.drift.caught",
        changed_paths: [".red/adr/0032.md"],
      });
    },
    TIMEOUT,
  );

  test(
    "multiple watched paths in one unmarked PR are all reported on the event (AC: multi-path)",
    async () => {
      const root = await tempRoot();
      await initGraph(root);
      const result = await runGuard(
        root,
        [".red/adr/0033.md", ".red/CONTEXT.md", ".red/contexts/afk.md"],
        "big docs change\n",
      );
      expect(result.status).toBe(1);
      const drift = await readDriftEvents(root);
      expect(drift).toHaveLength(1);
      expect(drift[0].payload).toMatchObject({
        changed_paths: [".red/adr/0033.md", ".red/CONTEXT.md", ".red/contexts/afk.md"],
      });
    },
    TIMEOUT,
  );

  test(
    "the guard still fails (without crashing) when memory is not initialized — telemetry is best-effort",
    async () => {
      const root = await tempRoot();
      // No initGraph — no config, no store.
      const result = await runGuard(root, [".red/adr/0034.md"], "docs(adr): add 0034\n");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Run /memory:ingest .red/adr/0034.md");
      // The ADR 0025 envelope is still emitted to stdout for CI logs.
      expect(result.stdout).toContain("memory.drift.caught");
    },
    TIMEOUT,
  );
});
