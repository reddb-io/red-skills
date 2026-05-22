import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { initGraph, initMarkdownOnly } from "../src/init.js";
import { parseSkillEventInput } from "../src/skill-events.js";

const EVENT = {
  event_type: "result",
  event_id: "evt-1",
  timestamp: "2026-05-22T16:00:00.000Z",
  session_id: "session-1",
  turn_id: "turn-1",
  name: "dev:tdd",
  source_kind: "plugin",
  path: "/plugins/dev/skills/engineering/tdd/SKILL.md",
  runner: "codex",
  result: {
    status: "succeeded",
    duration_ms: 1200,
    error_class: "none",
  },
};

const TIMEOUT = 30_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");
const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-skill-event-"));
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

describe("Skill telemetry event contract", () => {
  test("parses one safe skill result event", () => {
    const events = parseSkillEventInput(JSON.stringify(EVENT));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: "result",
      event_id: "evt-1",
      turn_id: "turn-1",
      name: "dev:tdd",
      runner: "codex",
      result: {
        status: "succeeded",
        duration_ms: 1200,
      },
    });
  });

  test("parses JSON array and JSONL batches", () => {
    const used = { ...EVENT, event_id: "evt-used", event_type: "used", result: undefined };

    expect(parseSkillEventInput(JSON.stringify([EVENT, used]))).toHaveLength(2);
    expect(
      parseSkillEventInput(`${JSON.stringify(EVENT)}\n${JSON.stringify(used)}\n`),
    ).toHaveLength(2);
  });

  test("rejects transcripts and unsafe result payloads", () => {
    expect(() =>
      parseSkillEventInput(
        JSON.stringify({
          ...EVENT,
          transcript: "agent said a lot of raw text",
        }),
      ),
    ).toThrow(/transcript/i);

    expect(() =>
      parseSkillEventInput(
        JSON.stringify({
          ...EVENT,
          result: { status: "crashed", output: "raw logs" },
        }),
      ),
    ).toThrow(/result/i);
  });
});

describe("memory event skill CLI", () => {
  test(
    "ingests one skill event from flags in graph mode",
    async () => {
      const root = await tempRoot();
      await initGraph(root);

      const result = runMemory([
        "event",
        "skill",
        "--root",
        root,
        "--event-type",
        "viewed",
        "--event-id",
        "evt-flags",
        "--timestamp",
        "2026-05-22T16:00:00.000Z",
        "--session-id",
        "session-1",
        "--turn-id",
        "turn-1",
        "--name",
        "memory:recall",
        "--source-kind",
        "plugin",
        "--path",
        "/plugins/memory/skills/core/recall/SKILL.md",
        "--runner",
        "codex",
      ]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("memory: ingested 1 skill event");

      const stats = runMemory(["stats", "--root", root]);
      expect(stats.stdout).toContain("memory: 1 node(s)");
    },
    TIMEOUT,
  );

  test(
    "ingests a JSONL skill event batch from stdin",
    async () => {
      const root = await tempRoot();
      await initGraph(root);
      const second = { ...EVENT, event_id: "evt-2", event_type: "used", result: undefined };
      const input = `${JSON.stringify(EVENT)}\n${JSON.stringify(second)}\n`;

      const result = runMemory(["event", "skill", "--root", root], input);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("memory: ingested 2 skill events");

      const stats = runMemory(["stats", "--root", root]);
      expect(stats.stdout).toContain("memory: 2 node(s)");
    },
    TIMEOUT,
  );

  test(
    "reports invalid explicit payloads without writing",
    async () => {
      const root = await tempRoot();
      await initGraph(root);

      const result = runMemory(
        ["event", "skill", "--root", root],
        JSON.stringify({ ...EVENT, transcript: "raw conversation text" }),
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("invalid skill event");
      expect(result.stderr).toContain("transcript");
    },
    TIMEOUT,
  );

  test(
    "no-ops clearly when memory is unavailable or not in graph mode",
    async () => {
      const uninitialized = await tempRoot();
      const missing = runMemory(["event", "skill", "--root", uninitialized], JSON.stringify(EVENT));
      expect(missing.status).toBe(0);
      expect(missing.stdout).toContain("not initialized");

      const markdown = await tempRoot();
      await initMarkdownOnly(markdown);
      const markdownResult = runMemory(
        ["event", "skill", "--root", markdown],
        JSON.stringify(EVENT),
      );
      expect(markdownResult.status).toBe(0);
      expect(markdownResult.stdout).toContain("needs graph mode");
    },
    TIMEOUT,
  );
});
