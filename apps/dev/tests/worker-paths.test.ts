import { afterEach, describe, expect, it } from "vitest";
import {
  allWorkersRoots,
  buildWorkerAttemptPath,
  issueAttemptsGlob,
  livePidsGlob,
  parseWorkerAttemptPath,
  WORKER_NAMESPACES,
  workerDir,
  workerPidFile,
  workersGlob,
  workersSegment,
} from "../src/core/worker-paths.js";

describe("worker paths", () => {
  it("round-trips the nested worker/issue/attempt layout", () => {
    const path = buildWorkerAttemptPath(".red/tmp/", "wZ2R4", 142, 3);
    expect(path).toBe(".red/tmp/workers/wZ2R4/142-a3");
    expect(parseWorkerAttemptPath(`${path}/`)).toEqual({ worker: "wZ2R4", issue: 142, attempt: 3 });
  });

  it("rejects malformed identities instead of constructing ambiguous paths", () => {
    expect(() => buildWorkerAttemptPath(".red/tmp", "../bad", 1, 1)).toThrow(/invalid worker/);
    expect(() => buildWorkerAttemptPath(".red/tmp", "wOK", "01", 1)).toThrow(/invalid issue/);
    expect(parseWorkerAttemptPath(".red/tmp/workers/wOK/01-a1")).toBeNull();
  });

  it("returns canonical globs and pid paths", () => {
    expect(issueAttemptsGlob(".red/tmp/", 42)).toBe(".red/tmp/workers/*/42-a*");
    expect(workersGlob(".red/tmp/")).toBe(".red/tmp/workers/*");
    expect(workerDir(".red/tmp/", "wAAAA")).toBe(".red/tmp/workers/wAAAA");
    expect(workerPidFile(".red/tmp/", "wAAAA")).toBe(".red/tmp/workers/wAAAA/worker.pid");
    expect(livePidsGlob(".red/tmp/")).toBe(".red/tmp/workers/*/worker.pid");
  });
});

describe("worker paths — /go namespace", () => {
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
    expect(path).toBe(".red/tmp/go-workers/wGO12/938-a1");
    expect(parseWorkerAttemptPath(path)).toEqual({ worker: "wGO12", issue: 938, attempt: 1 });
    expect(workersGlob(".red/tmp/")).toBe(".red/tmp/go-workers/*");
    expect(issueAttemptsGlob(".red/tmp/", 938)).toBe(".red/tmp/go-workers/*/938-a*");
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
