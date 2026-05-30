import { describe, expect, it } from "vitest";
import {
  buildWorkerAttemptPath,
  issueAttemptsGlob,
  livePidsGlob,
  parseWorkerAttemptPath,
  workerDir,
  workerPidFile,
  workersGlob,
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
