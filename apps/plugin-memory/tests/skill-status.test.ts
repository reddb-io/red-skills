import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { initGraph, initMarkdownOnly } from "../src/init.js";

const TIMEOUT = 30_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-status-"));
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

function skillEvent(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    event_type: "viewed",
    event_id: `evt-${Math.random().toString(36).slice(2)}`,
    timestamp: "2026-05-22T15:00:00.000Z",
    session_id: "s1",
    turn_id: "t1",
    name: "sample",
    source_kind: "project",
    path: "/skills/sample/SKILL.md",
    runner: "claude",
    ...overrides,
  });
}

describe("memory status skills CLI", () => {
  test(
    "uninitialized — diagnostic explains memory is not set up here",
    async () => {
      const root = await tempRoot();
      const result = runMemory(["status", "skills", "--root", root]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("uninitialized");
    },
    TIMEOUT,
  );

  test(
    "no-op — markdown-only mode has no engine to persist telemetry",
    async () => {
      const root = await tempRoot();
      await initMarkdownOnly(root);
      const result = runMemory(["status", "skills", "--root", root]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("no-op");
      expect(result.stdout).toMatch(/graph mode/i);
    },
    TIMEOUT,
  );

  test(
    "unavailable — graph mode but skill telemetry was never enabled",
    async () => {
      const root = await tempRoot();
      await initGraph(root, {});
      const result = runMemory(["status", "skills", "--root", root]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("unavailable");
      expect(result.stdout).toContain("--skill-telemetry");
    },
    TIMEOUT,
  );

  test(
    "enabled but empty — reports no skills observed yet",
    async () => {
      const root = await tempRoot();
      await initGraph(root, { skillTelemetry: true });
      const result = runMemory(["status", "skills", "--root", root]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("enabled");
      expect(result.stdout).toMatch(/no skills observed/i);
    },
    TIMEOUT,
  );

  test(
    "populated — defaults to curatable skills, --all adds bundled/plugin skills",
    async () => {
      const root = await tempRoot();
      await initGraph(root, { skillTelemetry: true });

      const proj = runMemory(
        ["event", "skill", "--root", root],
        skillEvent({ name: "proj-skill", source_kind: "project", event_id: "e-proj" }),
      );
      expect(proj.status).toBe(0);
      const bundled = runMemory(
        ["event", "skill", "--root", root],
        skillEvent({ name: "bundled-skill", source_kind: "plugin", event_id: "e-bundled" }),
      );
      expect(bundled.status).toBe(0);

      const def = runMemory(["status", "skills", "--root", root]);
      expect(def.status).toBe(0);
      expect(def.stdout).toContain("enabled");
      expect(def.stdout).toContain("proj-skill");
      // Default focuses on curatable skills — the plugin skill is hidden.
      expect(def.stdout).not.toContain("bundled-skill");

      const all = runMemory(["status", "skills", "--root", root, "--all"]);
      expect(all.status).toBe(0);
      expect(all.stdout).toContain("proj-skill");
      expect(all.stdout).toContain("bundled-skill");
    },
    TIMEOUT,
  );

  test(
    "--json emits a stable scriptable shape with state and rollups",
    async () => {
      const root = await tempRoot();
      await initGraph(root, { skillTelemetry: true });
      runMemory(
        ["event", "skill", "--root", root],
        skillEvent({ name: "proj-skill", source_kind: "project", event_id: "e1" }),
      );

      const result = runMemory(["status", "skills", "--root", root, "--all", "--json"]);
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.state).toBe("enabled");
      expect(parsed.totalSkills).toBe(1);
      expect(Array.isArray(parsed.skills)).toBe(true);
      expect(parsed.skills[0].name).toBe("proj-skill");
      expect(Array.isArray(parsed.recentEvents)).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "--json reports a non-enabled state without opening the store",
    async () => {
      const root = await tempRoot();
      await initMarkdownOnly(root);
      const result = runMemory(["status", "skills", "--root", root, "--json"]);
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.state).toBe("no-op");
    },
    TIMEOUT,
  );
});
