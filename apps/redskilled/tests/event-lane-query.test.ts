import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  REDSKILLED_WORKER_EVENT_KINDS,
  createRedskilledEventLane,
  type RecordWorkerEventInput,
} from "../src/event-lane.js";
import type { RedskilledWorkerView } from "../src/host-state.js";

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DOC_PATH = join(ROOT, "plugins/dev/skills/engineering/redskilled/SKILL.md");
const roots: string[] = [];

const TODAY_PERFORMANCE_QUERY =
  'select(.ts >= "2026-08-05T00:00:00.000Z") | {ts, kind, worker_id, project_label, phase, exit_code}';
const WORKER_STORY_QUERY =
  'select(.worker_id == "wDOCS") | {ts, kind, phase, step, base_commits_ahead, heal_kind, exit_code}';
const DRIFT_HEAL_COUNTS_QUERY =
  '{drift: map(select(.kind == "worker-drift")) | length, heals: map(select(.kind == "worker-heal")) | length}';

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function worker(): RedskilledWorkerView {
  return {
    worker_id: "wDOCS",
    project_label: "acme/widgets",
    pid: 4242,
    started_at: "2026-08-05T09:00:00.000Z",
    workspace_path: "/tmp/workspace",
    fork_sha: "aaaa1111",
    isolated: true,
    unit: "red-worker-wDOCS.service",
    warnings: [],
  };
}

function workerEvent(kind: RecordWorkerEventInput["kind"]): RecordWorkerEventInput {
  const common = { kind, worker: worker(), ts: "2026-08-05T09:00:00.000Z" } as const;
  switch (kind) {
    case "worker-birth":
      return { ...common, admissionVerdict: "admitted" };
    case "worker-activity":
      return { ...common, phase: "coding", step: "implementing" };
    case "worker-drift":
      return { ...common, baseHeadSha: "bbbb2222", baseCommitsAhead: 3 };
    case "worker-heal":
      return { ...common, healKind: "mechanical-regeneration", detail: "generated surfaces regenerated" };
    case "worker-death":
      return { ...common, exitCode: 0 };
    case "worker-budget-kill":
      return { ...common, detail: "host memory high-water mark exceeded", signal: "SIGKILL" };
  }
}

describe("queryable daemon worker-event log", () => {
  it("pins every worker record to the stable kind vocabulary", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-query-log-"));
    roots.push(root);
    const lane = createRedskilledEventLane(join(root, "redskilled.log.toonl"));

    for (const kind of REDSKILLED_WORKER_EVENT_KINDS) await lane.recordWorker(workerEvent(kind));

    const events = await lane.read();
    const workerEvents = events.filter((event) => event.worker_id === "wDOCS");
    expect(workerEvents.map((event) => event.kind)).toEqual(REDSKILLED_WORKER_EVENT_KINDS);
    expect(workerEvents.every((event) => REDSKILLED_WORKER_EVENT_KINDS.includes(event.kind))).toBe(true);
    expect(workerEvents.find((event) => event.kind === "worker-birth")).toMatchObject({
      admission_verdict: "admitted",
      fork_sha: "aaaa1111",
    });
  });

  it("runs the three documented tq recipes against a fixture lane", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-query-recipes-"));
    roots.push(root);
    const path = join(root, "redskilled.log.toonl");
    const lane = createRedskilledEventLane(path);
    await lane.recordWorker(workerEvent("worker-birth"));
    await lane.recordWorker({ ...workerEvent("worker-activity"), ts: "2026-08-05T09:01:00.000Z" });
    await lane.recordWorker({ ...workerEvent("worker-drift"), ts: "2026-08-05T09:02:00.000Z" });
    await lane.recordWorker({ ...workerEvent("worker-heal"), ts: "2026-08-05T09:03:00.000Z" });
    await lane.recordWorker({ ...workerEvent("worker-death"), ts: "2026-08-05T09:04:00.000Z" });

    const docs = await readFile(DOC_PATH, "utf8");
    expect(docs).toContain(TODAY_PERFORMANCE_QUERY);
    expect(docs).toContain(WORKER_STORY_QUERY);
    expect(docs).toContain(DRIFT_HEAL_COUNTS_QUERY);

    const today = await execFileAsync("tq", ["-p", "toonl", "-o", "json", TODAY_PERFORMANCE_QUERY, path]);
    expect(today.stdout.trim().split("\n")).toHaveLength(5);

    const story = await execFileAsync("tq", ["-p", "toonl", "-o", "json", WORKER_STORY_QUERY, path]);
    const storyRows = story.stdout.trim().split("\n").map((line) => JSON.parse(line) as { kind: string });
    expect(storyRows.map((row) => row.kind)).toEqual([
      "worker-birth",
      "worker-activity",
      "worker-drift",
      "worker-heal",
      "worker-death",
    ]);

    const counts = await execFileAsync("tq", [
      "-p",
      "toonl",
      "-o",
      "json",
      "--slurp",
      DRIFT_HEAL_COUNTS_QUERY,
      path,
    ]);
    expect(JSON.parse(counts.stdout)).toEqual({ drift: 1, heals: 1 });
  });
});
