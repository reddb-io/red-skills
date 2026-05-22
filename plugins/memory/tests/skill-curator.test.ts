import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { initGraph } from "../src/init.js";
import {
  curateSkills,
  type CuratorSkillInput,
} from "../src/skill-curator.js";

const TIMEOUT = 30_000;
const DAY = 86_400_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");
const NOW = Date.parse("2026-05-22T16:00:00.000Z");

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-curator-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function rollup(overrides: Partial<CuratorSkillInput>): CuratorSkillInput {
  return {
    name: "sample",
    source_kind: "project",
    path: "/skills/sample/SKILL.md",
    first_seen: "2026-01-01T00:00:00.000Z",
    last_activity: "2026-05-22T15:00:00.000Z",
    view_count: 1,
    use_count: 1,
    patch_count: 0,
    change_count: 0,
    result_count: 1,
    outcome_counts: { succeeded: 1 },
    curatable_status: "active",
    archive_signal: false,
    consolidation_signal: false,
    ...overrides,
  };
}

function runMemory(args: string[], input?: string) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: PLUGIN_ROOT,
    encoding: "utf8",
    input,
    timeout: TIMEOUT,
  });
}

describe("skill curator (pure, report-only)", () => {
  test("flags a stale curatable skill", () => {
    const report = curateSkills(
      [rollup({ name: "old", last_activity: "2026-01-01T00:00:00.000Z" })],
      { now: NOW, staleDays: 60 },
    );
    const stale = report.recommendations.filter((r) => r.category === "stale");
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ name: "old", curatable: true });
  });

  test("flags an abandoned skill — loaded repeatedly but never used", () => {
    const report = curateSkills(
      [rollup({ name: "ghost", view_count: 5, use_count: 0, result_count: 0, outcome_counts: {} })],
      { now: NOW },
    );
    expect(report.recommendations.some((r) => r.category === "abandoned" && r.name === "ghost")).toBe(
      true,
    );
  });

  test("flags a frequently-failing skill above the failure ratio", () => {
    const report = curateSkills(
      [
        rollup({
          name: "flaky",
          result_count: 10,
          outcome_counts: { failed: 8, succeeded: 2 },
        }),
      ],
      { now: NOW },
    );
    expect(
      report.recommendations.some((r) => r.category === "frequently-failing" && r.name === "flaky"),
    ).toBe(true);
  });

  test("emits consolidation and archive only for curatable skills", () => {
    const report = curateSkills(
      [
        rollup({ name: "proj", source_kind: "project", consolidation_signal: true, archive_signal: true }),
        rollup({ name: "bundled", source_kind: "plugin", consolidation_signal: true, archive_signal: true }),
      ],
      { now: NOW },
    );
    const mutationFor = (name: string) =>
      report.recommendations
        .filter((r) => r.name === name && (r.category === "consolidation" || r.category === "archive"))
        .map((r) => r.category)
        .sort();
    expect(mutationFor("proj")).toEqual(["archive", "consolidation"]);
    expect(mutationFor("bundled")).toEqual([]);
  });

  test("flags a restore candidate — archived but active again", () => {
    const report = curateSkills(
      [
        rollup({
          name: "revived",
          curatable_status: "archived",
          last_activity: "2026-05-22T15:00:00.000Z",
        }),
      ],
      { now: NOW, staleDays: 60 },
    );
    expect(report.recommendations.some((r) => r.category === "restore" && r.name === "revived")).toBe(
      true,
    );
  });

  test("counts curatable vs read-only skills", () => {
    const report = curateSkills(
      [
        rollup({ name: "a", source_kind: "project" }),
        rollup({ name: "b", source_kind: "user" }),
        rollup({ name: "c", source_kind: "plugin" }),
        rollup({ name: "d", source_kind: "hub" }),
      ],
      { now: NOW },
    );
    expect(report.totalSkills).toBe(4);
    expect(report.curatableSkills).toBe(2);
    expect(report.readOnlySkills).toBe(2);
  });
});

describe("memory curate skills CLI", () => {
  test(
    "produces a report-only output from fixture telemetry without mutating skill files",
    async () => {
      const root = await tempRoot();
      await initGraph(root, { skillTelemetry: true });

      // A real Curatable skill file on disk the curator must never touch.
      const skillDir = join(root, "skills", "stale-skill");
      await mkdir(skillDir, { recursive: true });
      const skillFile = join(skillDir, "SKILL.md");
      const skillBody = "# stale-skill\n\nfixture content the curator must not change\n";
      await writeFile(skillFile, skillBody, "utf8");
      const before = await stat(skillFile);

      const event = {
        event_type: "viewed",
        event_id: "evt-stale",
        timestamp: "2026-01-01T00:00:00.000Z",
        session_id: "s1",
        turn_id: "t1",
        name: "stale-skill",
        source_kind: "project",
        path: skillFile,
        runner: "claude",
      };
      const ingest = runMemory(["event", "skill", "--root", root], JSON.stringify(event));
      expect(ingest.status).toBe(0);

      const result = runMemory(["curate", "skills", "--root", root, "--stale-days", "60"]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("report-only");
      expect(result.stdout).toMatch(/stale/i);
      expect(result.stdout).toContain("stale-skill");

      // Skill file untouched: bytes and mtime unchanged.
      expect(await readFile(skillFile, "utf8")).toBe(skillBody);
      const after = await stat(skillFile);
      expect(after.mtimeMs).toBe(before.mtimeMs);
    },
    TIMEOUT,
  );

  test(
    "runs without an AI provider configured — no model-heavy review",
    async () => {
      const root = await tempRoot();
      await initGraph(root, { skillTelemetry: true });
      const result = runMemory(["curate", "skills", "--root", root]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("report-only");
    },
    TIMEOUT,
  );
});
