import { describe, expect, it } from "vitest";
import { mergeableState } from "../src/wait/github.js";
import { verdictForJob } from "../src/wait/probes.js";

describe("GitHub mergeability vocabulary", () => {
  it("normalizes REST dirty to the conflict verdict vocabulary", () => {
    expect(mergeableState({ mergeable_state: "dirty", mergeable: false })).toBe("CONFLICTING");
    expect(mergeableState({ mergeable_state: "clean", mergeable: true })).toBe("MERGEABLE");
  });
});

describe("GitHub Actions job verdicts", () => {
  it("keeps an in-progress job non-terminal", () => {
    expect(verdictForJob("93918599356", { status: "IN_PROGRESS", conclusion: "" })).toMatchObject({
      status: "running",
      summary: "job 93918599356 is in_progress",
    });
  });

  it("returns a compact successful terminal verdict", () => {
    expect(verdictForJob("93918599356", {
      databaseId: 93918599356,
      name: "Build binaries",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      url: "https://example.test/job",
    })).toMatchObject({
      status: "success",
      exitCode: 0,
      summary: "job 93918599356 succeeded",
      details: { job_id: 93918599356, name: "Build binaries", conclusion: "success" },
    });
  });
});
