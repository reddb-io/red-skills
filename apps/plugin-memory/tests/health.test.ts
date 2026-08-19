import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";
import { initGraph } from "../src/init.js";
import { buildMemoryHealthReport } from "../src/memory-health.js";
import { buildMemoryHealthViewerArtifact } from "../src/memory-health-viewer.js";
import { ingestSkillEvents, type SkillEvent } from "../src/skill-events.js";

const TIMEOUT = 30_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");
const roots: string[] = [];
const stores: MemoryStore[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-health-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: PLUGIN_ROOT,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

async function openStore(root: string): Promise<MemoryStore> {
  const store = await MemoryStore.open({
    uri: `file://${join(root, ".red/memory/graph.rdb")}`,
    project: "test",
  });
  stores.push(store);
  return store;
}

function resultEvent(i: number, skillPath: string): SkillEvent {
  return {
    event_type: "result",
    event_id: `evt-${i}`,
    timestamp: `2026-05-22T16:0${i}:00.000Z`,
    session_id: "session-1",
    turn_id: `turn-${i}`,
    name: "flaky-skill",
    source_kind: "local",
    path: skillPath,
    runner: "codex",
    result: {
      status: i <= 4 ? "failed" : "succeeded",
      error_class: i <= 4 ? "ValidationError" : undefined,
      error_stage: i <= 4 ? "verify" : undefined,
    },
  };
}

describe("memory health CLI", () => {
  test("reports operational memory health with telemetry, candidates, and pending proposals", async () => {
    const root = await tempRoot();
    await initGraph(root, { hooks: true, skillTelemetry: true });
    const skillDir = join(root, "skills", "flaky-skill");
    const skillPath = join(skillDir, "SKILL.md");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      skillPath,
      "---\nname: flaky-skill\ndescription: Flaky test skill.\n---\n\n# Flaky\n\n<what-to-do>\nRun the verifier.\n</what-to-do>\n",
      "utf8",
    );
    await mkdir(join(root, ".red", "memory", "proposals"), { recursive: true });
    await writeFile(join(root, ".red", "memory", "proposals", "pending.md"), "# Pending\n", "utf8");

    const store = await openStore(root);
    await ingestSkillEvents(store, [1, 2, 3, 4, 5].map((i) => resultEvent(i, skillPath)));
    await store.close();

    const result = runMemory(["health", "--root", root, "--json"]);
    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout);

    expect(body.state).toBe("attention");
    expect(body.initialized).toBe(true);
    expect(body.graphMode).toBe(true);
    expect(body.skillTelemetry).toBe("enabled");
    expect(body.rollups).toBe(1);
    expect(body.proposalCandidates).toBe(1);
    expect(body.highPriorityProposals).toBe(1);
    expect(body.pendingProposalFiles).toBe(1);
    expect(body.topProposals[0]).toMatchObject({
      skill: "flaky-skill",
      priority: "high",
      recentFailures: 4,
      dominantErrorStage: "verify",
    });
    expect(body.recommendedNextActions).toContain("review and apply the top high-priority Skill improvement proposal");

    const viewer = runMemory(["health-viewer", "--root", root, "--out", join(root, "health.html")]);
    expect(viewer.status, viewer.stderr).toBe(0);
    expect(viewer.stdout).toContain("memory: health viewer written");
    const html = await readFile(join(root, "health.html"), "utf8");
    expect(html).toContain("Memory Health");
    expect(html).toContain('id="memory-health-data"');
  }, TIMEOUT);

  test("builds a graph health report and self-contained viewer artifact", async () => {
    const root = await tempRoot();
    await initGraph(root, { hooks: true, skillTelemetry: true });
    const store = await openStore(root);
    await store.upsertNode({
      label: "memory-health-check",
      node_type: "concept",
      properties: { title: "Memory health check", content: "Health viewer evidence." },
    });

    const report = await buildMemoryHealthReport(store, { stale_days: 90 });
    expect(report).toMatchObject({
      schema_version: "memory.health.v1",
      read_only: true,
      stats: { nodes: expect.any(Number), edges: expect.any(Number) },
      skill_telemetry: { status: "available" },
    });

    const artifact = buildMemoryHealthViewerArtifact(report);
    expect(artifact.contract).toEqual({
      name: "memory.health.viewer",
      version: "memory.health.viewer.v1",
      consumes: "memory.health.v1",
    });
    expect(artifact.html).toContain("Memory Health");
    expect(artifact.html).toContain("Vector projection");
    expect(artifact.html).toContain('id="memory-health-data"');
    expect(artifact.html).not.toContain("<script src=");
  }, TIMEOUT);

  test("explains missing memory without failing", async () => {
    const root = await tempRoot();

    const result = runMemory(["health", "--root", root, "--json"]);
    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout);

    expect(body.state).toBe("missing");
    expect(body.initialized).toBe(false);
    expect(body.graphMode).toBe(false);
    expect(body.skillTelemetry).toBe("unavailable");
    expect(body.recommendedNextActions).toContain("run `memory init --mode graph --skill-telemetry` to enable graph recall and self-improvement telemetry");
  }, TIMEOUT);
});
