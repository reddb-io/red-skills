// A diagnostic outlives the artifact it describes, or it is not a diagnostic
// (#3156).
//
// `claim-lost` is the one outcome whose entire value is its `reason=` string —
// and it wrote that string to the per-worker iteration log, the very directory
// the claim-lost path deletes on the way out. Eight consecutive claim-lost
// deaths on #3155 therefore retained ZERO explanations, and the investigation
// went to the innocent subsystem because the guilty one had deleted its own
// testimony.
//
// These tests pin the two halves of the route: the arbitration account reaches
// a lane the sweep does not touch, and the operator-facing surface carries the
// same reason the log line does.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readHistoryRecords } from "../src/core/history.js";
import { zeroAttemptDispatchFailure } from "../src/core/go.js";
import { processIssue } from "../src/core/process-issue.js";
import { sweepDiscardsWorkspace } from "../src/core/worker-outcome.js";
import { harness } from "./process-issue.test-helpers.js";

describe("a claim-lost explanation survives its own sweep", () => {
  let root: string;
  let historyPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "claim-lost-diag-"));
    // The canonical durable lane — the one `.red/state/castle/` path the
    // per-worker sweep never reaches.
    historyPath = join(root, ".red", "state", "castle", "history.toonl");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes the arbitration account to the durable history lane, not only the swept iteration log", async () => {
    const { deps, input, trace } = harness({
      claim: { winner: "other" },
      labels: ["ready-for-agent", "running"],
      historyPath,
    });

    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("claim-lost");

    // The iteration log still says it — but that directory is deleted.
    expect(trace.iterLogs.some((l) => /claim-lost #9 .*reason=/.test(l))).toBe(true);

    // The durable lane says it too, and that one is kept.
    const records = await readHistoryRecords(historyPath);
    const lost = records.filter((r) => r.event === "claim-lost");
    expect(lost).toHaveLength(1);
    expect(lost[0]!.issue).toBe(9);
    expect(lost[0]!.reason).toMatch(/holder=/);
    expect(lost[0]!.reason).toMatch(/reason=/);
  });

  it("keeps the lane-mode refusal readable after the sweep, naming the cause rather than the outcome", async () => {
    const { deps, input } = harness({
      labels: ["ready-for-agent", "lane:scout"],
      historyPath,
    });

    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("claim-lost");

    const records = await readHistoryRecords(historyPath);
    const lost = records.find((r) => r.event === "claim-lost");
    expect(lost?.reason).toMatch(/lane:scout/);
  });

  it("returns the reason on the result, so the console does not have to read a deleted log", async () => {
    const { deps, input } = harness({
      claim: { winner: "other" },
      historyPath,
    });

    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("claim-lost");
    expect(result.reason).toBeTruthy();
    expect(result.reason).not.toBe("");
  });

  it("reports the reason in the zero-attempt dispatch verdict the operator reads", () => {
    const verdict = zeroAttemptDispatchFailure(true, [
      { issue: 3155, outcome: "claim-lost", reason: "boot probe failed: trunk fast-forward blocked" },
    ]);
    expect(verdict).toContain("#3155: claim-lost");
    expect(verdict).toContain("boot probe failed: trunk fast-forward blocked");
  });
});

describe("claim-lost is not silently grouped with the retention policy meant for done", () => {
  it("discards the workspace like done — which is exactly why its testimony must go elsewhere", () => {
    expect(sweepDiscardsWorkspace("done")).toBe(true);
    expect(sweepDiscardsWorkspace("claim-lost")).toBe(true);
    // A failure that kept its workspace keeps its own explanation with it.
    expect(sweepDiscardsWorkspace("blocked")).toBe(false);
    expect(sweepDiscardsWorkspace("no-sentinel")).toBe(false);
  });
});
