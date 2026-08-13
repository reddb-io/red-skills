import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REDSKILLED_WORKER_EVENT_KINDS,
  createRedskilledEventLane,
  type RecordWorkerEventInput,
} from "../src/event-lane.js";
import type { RedskilledWorkerView } from "../src/host-state.js";

const execFileAsync = promisify(execFile);

/**
 * Run a documented `tq` recipe, and say what is missing when `tq` is.
 *
 * `tq` is an external Rust binary rather than a workspace dependency, so an
 * environment without it fails at `spawn tq ENOENT` — a message that names
 * neither the tool nor the way to get it. This test is NEVER skipped for its
 * absence: the recipes it runs are the ones the /redskilled skill hands an
 * operator, and a recipe nothing executes is a recipe nothing keeps true.
 */
async function tq(args: readonly string[]): Promise<{ stdout: string }> {
  try {
    return await execFileAsync("tq", [...args]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new Error(
      "these are the tq recipes the /redskilled skill documents, and tq is not on PATH. " +
        "Install the prebuilt binary from the reddb-io/toon releases (tq-linux-x86_64-static), " +
        "or `cargo install reddb-io-tq`. CI installs the pinned release.",
    );
  }
}
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DOC_PATH = join(ROOT, "plugins/dev/skills/engineering/redskilled/SKILL.md");
const roots: string[] = [];

const TODAY_PERFORMANCE_QUERY =
  'select(.ts >= "2026-08-05T00:00:00.000Z") | {ts: .ts, kind: .kind, worker_id: .worker_id, project_label: .project_label, phase: .phase, exit_code: .exit_code}';
const WORKER_STORY_QUERY =
  'select(.worker_id == "wDOCS") | {ts: .ts, kind: .kind, phase: .phase, step: .step, base_commits_ahead: .base_commits_ahead, heal_kind: .heal_kind, exit_code: .exit_code}';
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
    case "worker-metrics":
      return { ...common, tokens: 42_000, tools: 31, runner: "codex", model: "gpt-5.6" };
    case "worker-resource":
      return { ...common, memoryPeakBytes: 1024, memorySwapPeakBytes: 512, pidsPeak: 7 };
    case "worker-drift":
      return { ...common, baseHeadSha: "bbbb2222", baseCommitsAhead: 3 };
    case "worker-heal":
      return { ...common, healKind: "mechanical-regeneration", detail: "generated surfaces regenerated" };
    case "worker-budget-verdict":
    case "worker-budget-grace":
      return { ...common, detail: "MemoryMax budget exceeded" };
    case "worker-death":
      return { ...common, exitCode: 0 };
    case "worker-budget-kill":
      return { ...common, detail: "host memory high-water mark exceeded", signal: "SIGKILL" };
  }
}

describe("queryable daemon worker-event log", () => {
  it("skips and reports a historical mixed-arity row between schema segments", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-mixed-arity-"));
    roots.push(root);
    const path = join(root, "redskilled.log.toonl");
    await createRedskilledEventLane(path).recordWorker(workerEvent("worker-birth"));
    await createRedskilledEventLane(path).recordWorker({ ...workerEvent("worker-activity"), ts: "2026-08-05T09:01:00.000Z" });
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    lines.splice(1, 0, "1,bad,mixed-arity,row");
    await writeFile(path, `${lines.join("\n")}\n`);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const events = await createRedskilledEventLane(path).read();

    expect(events.map((event) => event.kind)).toEqual(["worker-birth", "worker-activity"]);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("1 malformed row(s)"));
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("line 2"));
    warning.mockRestore();
  });
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
    expect(workerEvents.find((event) => event.kind === "worker-metrics")).toMatchObject({
      tokens: 42_000,
      tools: 31,
      runner: "codex",
      model: "gpt-5.6",
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

    const today = await tq(["-p", "toonl", "-o", "json", "-c", TODAY_PERFORMANCE_QUERY, path]);
    expect(today.stdout.trim().split("\n")).toHaveLength(5);

    const story = await tq(["-p", "toonl", "-o", "json", "-c", WORKER_STORY_QUERY, path]);
    const storyRows = story.stdout.trim().split("\n").map((line) => JSON.parse(line) as { kind: string });
    expect(storyRows.map((row) => row.kind)).toEqual([
      "worker-birth",
      "worker-activity",
      "worker-drift",
      "worker-heal",
      "worker-death",
    ]);

    const counts = await tq([
      "-p",
      "toonl",
      "-o",
      "json",
      "-c",
      "--slurp",
      DRIFT_HEAL_COUNTS_QUERY,
      path,
    ]);
    expect(JSON.parse(counts.stdout)).toEqual({ drift: 1, heals: 1 });
  });
});
