import { describe, expect, it, vi } from "vitest";
import { reconcileDeadWorkerClaim } from "../src/core/supervisor.js";
import type { HealLedgerState, HealLedgerStore } from "@reddb-io/red-castle/engine";
import { makeDeps } from "./supervisor-test-helpers.js";
import type { IterDirInfo } from "../src/core/supervisor.js";

function info(issue = 2526): IterDirInfo {
  return { issue, workerId: "wTEST", attempt: 1, iterDir: "/tmp/x" } as unknown as IterDirInfo;
}

function memoryLedger(initial: Record<string, number[]> = {}): HealLedgerStore {
  let state: HealLedgerState = { version: 1, issues: initial };
  return {
    read: async () => state,
    write: async (next) => {
      state = next;
    },
  };
}

describe("death-sweep (#2526, ADR 0122)", () => {
  it("escalation parks through the atomic transition: exactly one state role survives in ONE edit", async () => {
    const { deps, io } = makeDeps();
    // crashed cap defaults to 1 and the fixture is attempt 1 → escalate/park.
    io.crashedClaimState.mockImplementation(async () => ({
      ghOk: true,
      stillRunning: true,
      envelopePosted: true,
      labels: ["running", "ready-for-agent", "blocked:crashed", "ready-for-human", "bug"],
    }));
    const reconciled = await reconcileDeadWorkerClaim(info(), deps);
    expect(reconciled).toBe(2526);
    expect(io.editLabels).toHaveBeenCalledTimes(1);
    const [, add, remove] = io.editLabels.mock.calls[0]!;
    // The no-sentinel Park keeps ready-for-human, replaces the stale process-
    // crash classification with blocked:runner, and atomically sheds the
    // poison pair that froze fleets on 2026-07-22: ready-for-agent + running.
    expect(new Set(remove as string[])).toEqual(
      new Set(["ready-for-agent", "running", "blocked:crashed"]),
    );
    expect(add as string[]).toEqual(["blocked:runner"]);
  });

  it("re-queues under the retry cap through the atomic queue transition", async () => {
    const { deps, io } = makeDeps();
    deps.recoveryEnv = { RED_AFK_RETRY_CRASH: "3" };
    io.crashedClaimState.mockImplementation(async () => ({
      ghOk: true,
      stillRunning: true,
      envelopePosted: true,
      labels: ["running", "ready-for-agent", "blocked:crashed", "ready-for-human", "bug"],
    }));
    const reconciled = await reconcileDeadWorkerClaim(info(), deps);
    expect(reconciled).toBe(2526);
    expect(io.editLabels).toHaveBeenCalledTimes(1);
    const [, add, remove] = io.editLabels.mock.calls[0]!;
    expect(new Set(remove as string[])).toEqual(
      new Set(["running", "blocked:crashed", "ready-for-human"]),
    );
    expect(add as string[]).toEqual([]);
  });

  it("quarantines on the 3rd heal of the same issue inside the ledger window", async () => {
    const { deps, io } = makeDeps();
    const now = Date.now();
    deps.healLedger = memoryLedger({ "2526": [now - 60_000, now - 30_000] });
    io.crashedClaimState.mockImplementation(async () => ({
      ghOk: true,
      stillRunning: true,
      envelopePosted: true,
      labels: ["running", "ready-for-agent"],
    }));
    const reconciled = await reconcileDeadWorkerClaim(info(), deps);
    expect(reconciled).toBe(2526);
    expect(io.ensureLabel).toHaveBeenCalledWith("quarantine");
    const [, add, remove] = io.editLabels.mock.calls[0]!;
    expect(add as string[]).toContain("quarantine");
    expect(new Set(remove as string[])).toEqual(new Set(["running", "ready-for-agent"]));
    const comments = io.comment.mock.calls.map((c) => String(c[1]));
    expect(comments.some((c) => c.includes("heal budget"))).toBe(true);
  });

  it("first heal of an issue still re-queues (ledger records, does not quarantine)", async () => {
    const { deps, io } = makeDeps();
    deps.healLedger = memoryLedger();
    io.crashedClaimState.mockImplementation(async () => ({
      ghOk: true,
      stillRunning: true,
      envelopePosted: true,
      labels: ["running", "ready-for-agent"],
    }));
    await reconcileDeadWorkerClaim(info(), deps);
    const [, add] = io.editLabels.mock.calls[0]!;
    expect(add as string[]).not.toContain("quarantine");
  });

  it("is idempotent: a second reap of an already-reconciled claim performs no mutation", async () => {
    const { deps, io } = makeDeps();
    io.crashedClaimState.mockImplementation(async () => ({
      ghOk: true,
      stillRunning: false,
      envelopePosted: true,
      labels: ["ready-for-agent"],
    }));
    const reconciled = await reconcileDeadWorkerClaim(info(), deps);
    expect(reconciled).toBeNull();
    expect(io.editLabels).not.toHaveBeenCalled();
    expect(io.comment).not.toHaveBeenCalled();
  });

  it("falls back to the legacy dispose sets when the impl reports no labels", async () => {
    const { deps, io } = makeDeps();
    io.crashedClaimState.mockImplementation(async () => ({
      ghOk: true,
      stillRunning: true,
      envelopePosted: true,
    }));
    const reconciled = await reconcileDeadWorkerClaim(info(), deps);
    expect(reconciled).toBe(2526);
    expect(io.editLabels).toHaveBeenCalledTimes(1);
  });
});
