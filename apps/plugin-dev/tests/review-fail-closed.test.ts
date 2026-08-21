/**
 * The verifier of ADR 0154: adversarial review defaults ON, fails CLOSED, and
 * writes what it concluded to the Countersign ledger (Tickets #4137 and #4172, Spec #4129).
 *
 * The risk the Spec names by hand is a deadlock — fail-closed plus a dead
 * reviewer runner is a drain where every issue parks — so the tests below prove
 * the park is BOUNDED (one reviewer call, no retry) and VISIBLE (a
 * `verifier-blocked` row plus `ready-for-human`), and that `advisory` mode
 * restores the ADR 0110 non-blocking behaviour while still recording every row.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getConfig, loadConfig } from "../src/core/config.js";
import { resolveAdversarialReviewConfig } from "../src/core/adversarial-review.js";
import type {
  AdversarialReviewContext,
  AdversarialReviewFindings,
} from "../src/core/adversarial-review.js";
import {
  DEFAULT_REVIEW_MODE,
  DEFAULT_REVIEW_PASS_COUNTERSIGN,
  REVIEW_MODES,
  UNPINNED_VERIFIER_IDENTITY,
  decideReviewStage,
  resolveReviewMode,
  runReviewStage,
  type AdversarialReviewer,
  type ReviewStagePark,
} from "../src/core/review-fail-closed.js";
import {
  resolveReviewVerifier,
  reviewImplementerIdentity,
  type ReviewVerifier,
} from "../src/core/review-verifier-identity.js";
import { createCountersignLedger, type CountersignLedger } from "../src/core/countersign-ledger.js";

const IMPLEMENTER = { runner: "claude", model: "claude-opus-5", effort: "high" } as const;
const KEY = { pr: 4137, head_sha: "c".repeat(40), patch_id: "d".repeat(40) };

const CONTEXT: AdversarialReviewContext = {
  issueNumber: 4137,
  issueTitle: "Adversarial review default-on, fail-closed, writes Countersign rows",
  issueBody: "## Acceptance criteria\n- [ ] the review stage fails closed",
  diff: "diff --git a/x.ts b/x.ts",
  base: "origin/main",
};

const CLEAN: AdversarialReviewFindings = { summary: "nothing blocks", score: 0.9, findings: [] };
const REFUSED: AdversarialReviewFindings = {
  summary: "the acceptance criteria are not met",
  score: 0.2,
  findings: [{ path: "x.ts", line: 1, body: "wrong", blocking: true }],
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function ledger(): Promise<CountersignLedger> {
  const root = await mkdtemp(join(tmpdir(), "review-fail-closed-"));
  roots.push(root);
  let tick = 0;
  return createCountersignLedger(root, {
    clock: () => new Date(Date.UTC(2026, 7, 21, 0, 0, tick++)).toISOString(),
  });
}

function shippedValues() {
  return loadConfig("/nonexistent/.red/config.yaml", {
    ignoreActivationGate: true,
    warn: () => {},
  });
}

function verifier(): ReviewVerifier {
  const resolved = resolveReviewVerifier({
    config: resolveAdversarialReviewConfig((key) => getConfig(shippedValues(), key)),
    implementer: IMPLEMENTER,
    taskClass: "complex",
  });
  expect(resolved).not.toBeNull();
  return resolved!;
}

/** A reviewer that counts its calls, so "no retry loop" is an assertion. */
function countingReviewer(
  answer: () => Promise<AdversarialReviewFindings>,
): AdversarialReviewer & { calls: number } {
  const reviewer = {
    calls: 0,
    async review() {
      reviewer.calls += 1;
      return await answer();
    },
  };
  return reviewer;
}

describe("review defaults (#4137)", () => {
  it("ships review ENABLED and the mode BLOCKING", () => {
    const values = shippedValues();
    expect(getConfig(values, "dev.review.enabled")).toBe("true");
    expect(getConfig(values, "dev.review.mode")).toBe("blocking");
    expect(resolveAdversarialReviewConfig((key) => getConfig(values, key)).enabled).toBe(true);
    expect(resolveReviewMode((key) => getConfig(values, key))).toBe(DEFAULT_REVIEW_MODE);
    expect(REVIEW_MODES).toEqual(["blocking", "advisory"]);
  });

  it("reads the operator escape hatch, and resolves anything unreadable back to blocking", () => {
    const advisory = loadConfig("/x/.red/config.yaml", {
      ignoreActivationGate: true,
      read: () => "plugins:\n  dev:\n    review:\n      mode: advisory\n",
    });
    expect(resolveReviewMode((key) => getConfig(advisory, key))).toBe("advisory");

    const typo = loadConfig("/x/.red/config.yaml", {
      ignoreActivationGate: true,
      read: () => "plugins:\n  dev:\n    review:\n      mode: advisroy\n",
    });
    expect(resolveReviewMode((key) => getConfig(typo, key))).toBe("blocking");
  });
});

describe("fail-closed review stage (#4137)", () => {
  it("turns a reviewer exception into a verifier-blocked row and a ready-for-human park", async () => {
    const lane = await ledger();
    const reviewer = countingReviewer(async () => {
      throw new Error("reviewer runner is down");
    });
    const parks: ReviewStagePark[] = [];

    const result = await runReviewStage(
      { key: KEY, context: CONTEXT, mode: "blocking", verifier: verifier() },
      { reviewer, ledger: lane, park: async (park) => void parks.push(park) },
    );

    expect(result.decision.countersign).toBe("verifier-blocked");
    expect(result.decision.stage).toEqual({ stage: "review", ok: false });
    expect(result.decision.park).toEqual({
      label: "ready-for-human",
      reason: "reviewer threw: reviewer runner is down",
    });
    expect(parks).toHaveLength(1);
    // Bounded: the reviewer is asked once and the decision can never say retry.
    expect(reviewer.calls).toBe(1);
    expect(result.decision.retry).toBe(false);

    const rows = await lane.read();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      pr: KEY.pr,
      head_sha: KEY.head_sha,
      countersign: "verifier-blocked",
      reason: "reviewer threw: reviewer runner is down",
    });
  });

  it("treats an unwired reviewer runner as blocked, never as a skip", async () => {
    const lane = await ledger();
    const result = await runReviewStage(
      { key: KEY, context: CONTEXT, mode: "blocking", verifier: verifier() },
      { reviewer: null, ledger: lane },
    );
    expect(result.attempt.status).toBe("unavailable");
    expect(result.decision.countersign).toBe("verifier-blocked");
    expect(result.decision.stage.skipped).toBeUndefined();
    expect(result.decision.park?.label).toBe("ready-for-human");
    expect(await lane.read()).toHaveLength(1);
  });

  it("blocks rather than self-signing when no identity differs from the implementer", async () => {
    const lane = await ledger();
    const reviewer = countingReviewer(async () => CLEAN);
    const result = await runReviewStage(
      { key: KEY, context: CONTEXT, mode: "blocking", verifier: null },
      { reviewer, ledger: lane },
    );
    expect(reviewer.calls).toBe(0);
    expect(result.decision.countersign).toBe("verifier-blocked");
    expect(result.decision.identity).toBe(UNPINNED_VERIFIER_IDENTITY);
    expect(result.decision.park?.reason).toContain("distinct from the implementer");
  });

  it("writes a passing Countersign under an identity that is NOT the implementer's", async () => {
    const lane = await ledger();
    const pinned = verifier();
    const result = await runReviewStage(
      {
        key: KEY,
        context: CONTEXT,
        mode: "blocking",
        verifier: pinned,
        evidence: "https://github.com/reddb-io/red-skills/actions/runs/1",
      },
      { reviewer: countingReviewer(async () => CLEAN), ledger: lane },
    );

    expect(result.decision.countersign).toBe(DEFAULT_REVIEW_PASS_COUNTERSIGN);
    expect(result.decision.stage).toEqual({ stage: "review", ok: true });
    expect(result.decision.park).toBeNull();

    const [row] = await lane.read();
    expect(row!.verifier_identity).toBe(pinned.identity);
    expect(row!.verifier_identity).not.toBe(reviewImplementerIdentity(IMPLEMENTER));
    expect(row!.countersign).toBe("test-verified");
    expect(row!.voided).toBe(false);
    expect(row!.evidence).toBe("https://github.com/reddb-io/red-skills/actions/runs/1");
    expect(await lane.standing(KEY)).toMatchObject({ countersign: "test-verified" });
  });

  it("records a reviewer that RAN and refused as verifier-failed, and does not park it", async () => {
    const lane = await ledger();
    const result = await runReviewStage(
      { key: KEY, context: CONTEXT, mode: "blocking", verifier: verifier() },
      { reviewer: countingReviewer(async () => REFUSED), ledger: lane },
    );
    expect(result.decision.countersign).toBe("verifier-failed");
    expect(result.decision.stage).toEqual({ stage: "review", ok: false });
    // A blocking FINDING is work for the implementer, not a human decision.
    expect(result.decision.park).toBeNull();
  });

  it("honours a caller's stronger pass class when the review sat on a live run", () => {
    expect(
      decideReviewStage({
        mode: "blocking",
        verifier: verifier(),
        attempt: { status: "reviewed", findings: CLEAN },
        passCountersign: "live-verified",
      }).countersign,
    ).toBe("live-verified");
  });

  it("blocks a clean review whose appraisal is under the configured floor", () => {
    expect(
      decideReviewStage({
        mode: "blocking",
        verifier: verifier(),
        attempt: { status: "reviewed", findings: CLEAN },
        appraisalFloor: 0.95,
      }),
    ).toMatchObject({ countersign: "verifier-failed", stage: { stage: "review", ok: false } });
  });
});

describe("advisory mode escape hatch (#4137)", () => {
  it("restores the non-blocking behaviour while still writing the row", async () => {
    const lane = await ledger();
    const parks: ReviewStagePark[] = [];
    const result = await runReviewStage(
      { key: KEY, context: CONTEXT, mode: "advisory", verifier: verifier() },
      {
        reviewer: countingReviewer(async () => {
          throw new Error("reviewer runner is down");
        }),
        ledger: lane,
        park: async (park) => void parks.push(park),
      },
    );

    expect(result.decision.countersign).toBe("verifier-blocked");
    expect(result.decision.stage).toEqual({ stage: "review", ok: true, skipped: true });
    expect(result.decision.park).toBeNull();
    expect(parks).toEqual([]);
    // An advisory drain is still auditable afterwards: the row is written.
    expect(await lane.read()).toHaveLength(1);
  });

  it("lets a refusing reviewer through, so a repair drain is not bricked", () => {
    expect(
      decideReviewStage({
        mode: "advisory",
        verifier: verifier(),
        attempt: { status: "reviewed", findings: REFUSED },
      }),
    ).toMatchObject({ countersign: "verifier-failed", stage: { stage: "review", ok: true } });
  });

  it("simulates a reviewer-runner-down drain and proves every issue parks exactly once", async () => {
    const lane = await ledger();
    const reviewer = countingReviewer(async () => {
      throw new Error("ECONNREFUSED");
    });
    const parks: ReviewStagePark[] = [];
    const issues = [4137, 4138, 4139];

    for (const pr of issues) {
      await runReviewStage(
        {
          key: { pr, head_sha: "e".repeat(40), patch_id: "f".repeat(40) },
          context: CONTEXT,
          mode: "blocking",
          verifier: verifier(),
        },
        { reviewer, ledger: lane, park: async (park) => void parks.push(park) },
      );
    }

    // One reviewer call and one park per issue: the drain stalls loudly and
    // terminates, rather than re-looping against a runner that is down.
    expect(reviewer.calls).toBe(issues.length);
    expect(parks).toHaveLength(issues.length);
    const rows = await lane.read();
    expect(rows).toHaveLength(issues.length);
    expect(rows.every((row) => row.countersign === "verifier-blocked")).toBe(true);
  });
});
