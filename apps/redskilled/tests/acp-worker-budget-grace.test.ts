import { describe, expect, it, vi } from "vitest";
import {
  REDSKILLED_WORKER_BUDGET_GRACE_METHOD,
  createAcpWorkerBudgetGraceRuntime,
  type WorkerBudgetGraceEnvelope,
} from "@reddb-io/worker/acp";

describe("ACP Worker Budget grace", () => {
  it("cancels, checkpoints, requests tokenless publication, writes its Envelope, and exits in order", async () => {
    const order: string[] = [];
    let envelope: WorkerBudgetGraceEnvelope | undefined;
    const requestPublication = vi.fn(async (_request: unknown) => {
      order.push("publication");
      return { publication_id: "queued:worker-budget-grace:wGRACE" };
    });
    const runtime = createAcpWorkerBudgetGraceRuntime({
      cancelChildAgent: async () => { order.push("cancel"); },
      checkpointLocalWork: async () => {
        order.push("checkpoint");
        return { ref: "refs/heads/worker-3842", sha: "a".repeat(40) };
      },
      requestPublication,
      writeEnvelope: async (value) => { order.push("envelope"); envelope = value; },
      terminate: async () => { order.push("exit"); },
    });

    expect(REDSKILLED_WORKER_BUDGET_GRACE_METHOD).toBe("_redskills/worker_budget_grace");
    await runtime.receive({
      version: 1,
      worker_id: "wGRACE",
      detail: "memory budget exceeded",
      deadline_at: "2026-08-15T23:00:30.000Z",
    });

    expect(order).toEqual(["cancel", "checkpoint", "publication", "envelope", "exit"]);
    expect(requestPublication).toHaveBeenCalledWith({
      idempotency_key: "worker-budget-grace:wGRACE",
      write: {
        kind: "repository-push",
        ref: "refs/heads/worker-3842",
        sha: "a".repeat(40),
      },
    });
    expect(requestPublication.mock.calls[0]![0]).not.toHaveProperty("credential");
    expect(requestPublication.mock.calls[0]![0]).not.toHaveProperty("token");
    expect(envelope).toMatchObject({
      outcome: "budget-exceeded",
      worker_id: "wGRACE",
      publication_requested: true,
      blocker: {
        status: "blocked",
        kind: "budget",
        next: "Decide whether to requeue with a larger budget, re-scope, or stop.",
      },
    });
  });

  it("attempts the Envelope and exit even when an earlier checkpoint stage overruns or fails", async () => {
    const order: string[] = [];
    let envelope: WorkerBudgetGraceEnvelope | undefined;
    const runtime = createAcpWorkerBudgetGraceRuntime({
      cancelChildAgent: async () => { order.push("cancel"); },
      checkpointLocalWork: async () => { order.push("checkpoint"); throw new Error("checkpoint overran"); },
      requestPublication: async () => { order.push("publication"); return {}; },
      writeEnvelope: async (value) => { order.push("envelope"); envelope = value; },
      terminate: async () => { order.push("exit"); },
    });

    await runtime.receive({
      version: 1,
      worker_id: "wOVERRUN",
      detail: "memory budget exceeded",
      deadline_at: "2026-08-15T23:00:30.000Z",
    });

    expect(order).toEqual(["cancel", "checkpoint", "envelope", "exit"]);
    expect(envelope?.failures).toEqual(["checkpoint: checkpoint overran"]);
    expect(envelope?.publication_requested).toBe(false);
  });

  it("coalesces repeated grace controls into one terminal transaction", async () => {
    const terminate = vi.fn(async () => undefined);
    const runtime = createAcpWorkerBudgetGraceRuntime({
      cancelChildAgent: async () => undefined,
      checkpointLocalWork: async () => null,
      requestPublication: async () => ({}),
      writeEnvelope: async () => undefined,
      terminate,
    });
    const control = {
      version: 1 as const,
      worker_id: "wONCE",
      detail: "budget exceeded",
      deadline_at: "2026-08-15T23:00:30.000Z",
    };

    await Promise.all([runtime.receive(control), runtime.receive(control)]);

    expect(terminate).toHaveBeenCalledTimes(1);
  });
});
