import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  allWorkersRoots,
  buildWorkerAttemptPath,
  buildWorkerWorktreePath,
  issueAttemptsGlob,
  livePidsGlob,
  parseReapableWorkerWorktreePath,
  parseWorkerAttemptPath,
  parseWorkerWorktreePath,
  WORKER_NAMESPACES,
  workerDir,
  workerPidFile,
  workersGlob,
  workersSegment,
} from "../src/core/worker-paths.js";

describe("worker paths", () => {
  beforeEach(() => {
    delete process.env.RED_AFK_WORKERS_NAMESPACE;
  });

  afterEach(() => {
    delete process.env.RED_AFK_WORKERS_NAMESPACE;
  });

  it("builds the worker/issue layout without attempt suffixes for new runs", () => {
    const path = buildWorkerAttemptPath(".red/tmp/", "wZ2R4", 142, 3);
    expect(path).toBe(".red/tmp/workers/wZ2R4/142");
    expect(parseWorkerAttemptPath(`${path}/`)).toEqual({ worker: "wZ2R4", issue: 142, attempt: 1 });
  });

  it("builds and parses the conventional worktree directly inside the worker workspace", () => {
    const path = buildWorkerWorktreePath(".red/tmp/", "wZ2R4", 142, 3);
    expect(path).toBe(".red/tmp/workers/wZ2R4/142/worktree");
    expect(parseWorkerWorktreePath(`${path}/`)).toEqual({
      worker: "wZ2R4",
      issue: 142,
      attempt: 1,
    });
  });

  it("accepts castle-branded nested worktrees through the hygiene parser only", () => {
    const legacy =
      ".red/tmp/workers/wZ2R4/142/.red-castle/worktrees/afk-wZ2R4-142-flatten";
    expect(parseWorkerWorktreePath(legacy)).toBeNull();
    expect(parseReapableWorkerWorktreePath(legacy)).toEqual({
      worker: "wZ2R4",
      issue: 142,
      attempt: 1,
    });
    expect(parseReapableWorkerWorktreePath(".red/tmp/workers/wZ2R4/142/worktree")).toEqual({
      worker: "wZ2R4",
      issue: 142,
      attempt: 1,
    });
  });

  it("ignores retained legacy attempt-suffixed directories (readers drop the -a level, ADR 0103)", () => {
    expect(parseWorkerAttemptPath(".red/tmp/workers/wZ2R4/142-a3")).toBeNull();
  });

  it("rejects malformed identities instead of constructing ambiguous paths", () => {
    expect(() => buildWorkerAttemptPath(".red/tmp", "../bad", 1, 1)).toThrow(/invalid worker/);
    expect(() => buildWorkerAttemptPath(".red/tmp", "wOK", "01", 1)).toThrow(/invalid issue/);
    expect(parseWorkerAttemptPath(".red/tmp/workers/wOK/01")).toBeNull();
  });

  it("returns canonical globs and pid paths", () => {
    expect(issueAttemptsGlob(".red/tmp/", 42)).toBe(".red/tmp/workers/*/42*");
    expect(workersGlob(".red/tmp/")).toBe(".red/tmp/workers/*");
    expect(workerDir(".red/tmp/", "wAAAA")).toBe(".red/tmp/workers/wAAAA");
    expect(workerPidFile(".red/tmp/", "wAAAA")).toBe(".red/tmp/workers/wAAAA/worker.pid");
    expect(livePidsGlob(".red/tmp/")).toBe(".red/tmp/workers/*/worker.pid");
  });
});

describe("worker paths — /go namespace", () => {
  beforeEach(() => {
    delete process.env.RED_AFK_WORKERS_NAMESPACE;
  });

  afterEach(() => {
    delete process.env.RED_AFK_WORKERS_NAMESPACE;
  });

  it("defaults to the `workers` segment when no namespace is set", () => {
    expect(workersSegment()).toBe("workers");
  });

  it("redirects every path to `go-workers` so /go never collides with the fleet", () => {
    process.env.RED_AFK_WORKERS_NAMESPACE = "go-workers";
    expect(workersSegment()).toBe("go-workers");
    const path = buildWorkerAttemptPath(".red/tmp/", "wGO12", 938, 1);
    expect(path).toBe(".red/tmp/go-workers/wGO12/938");
    expect(parseWorkerAttemptPath(path)).toEqual({ worker: "wGO12", issue: 938, attempt: 1 });
    expect(workersGlob(".red/tmp/")).toBe(".red/tmp/go-workers/*");
    expect(issueAttemptsGlob(".red/tmp/", 938)).toBe(".red/tmp/go-workers/*/938*");
    expect(workerDir(".red/tmp/", "wGO12")).toBe(".red/tmp/go-workers/wGO12");
    expect(livePidsGlob(".red/tmp/")).toBe(".red/tmp/go-workers/*/worker.pid");
  });

  it("ignores an unsafe namespace value and falls back to `workers`", () => {
    process.env.RED_AFK_WORKERS_NAMESPACE = "../escape";
    expect(workersSegment()).toBe("workers");
  });

  it("enumerates every worker-lane namespace for read-only union discovery", () => {
    expect([...WORKER_NAMESPACES]).toEqual(["workers", "go-workers", "scout-workers"]);
    expect(allWorkersRoots("/repo/.red/tmp/")).toEqual([
      "/repo/.red/tmp/workers",
      "/repo/.red/tmp/go-workers",
      "/repo/.red/tmp/scout-workers",
    ]);
    expect(parseWorkerAttemptPath("/repo/.red/tmp/scout-workers/wSCOUT/15")).toEqual({
      worker: "wSCOUT",
      issue: 15,
      attempt: 1,
    });
  });

  it("allWorkersRoots is namespace-blind (ignores RED_AFK_WORKERS_NAMESPACE)", () => {
    process.env.RED_AFK_WORKERS_NAMESPACE = "go-workers";
    // The read-only aggregator must union ALL lanes regardless of the env
    // override the reader process happens to carry.
    expect(allWorkersRoots("/repo/.red/tmp")).toEqual([
      "/repo/.red/tmp/workers",
      "/repo/.red/tmp/go-workers",
      "/repo/.red/tmp/scout-workers",
    ]);
  });
});
