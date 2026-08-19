import { describe, expect, it } from "vitest";
import {
  evaluateClaimTrust,
  type ActorTrustLookup,
  type TrustPolicy,
  type TrustProvenance,
} from "../src/core/trust-gate.js";
import type { IssueCandidate } from "../src/core/session.js";

interface QueueStatusError {
  kind: "trust-read";
  number: number;
  message: string;
}

/** Compatibility projection for the retired adapter fixture. Trust evaluation
 * remains the live core; only the old queue-shaped response is assembled here. */
function buildQueueStatus(
  eligible: readonly IssueCandidate[],
  held: readonly IssueCandidate[],
  readyForHuman: readonly unknown[],
  errors: readonly QueueStatusError[] = [],
) {
  const project = ({ body: _body, author: _author, ...candidate }: IssueCandidate) => candidate;
  return {
    ready_for_agent: {
      eligible: eligible.map(project),
      held_for_summon: held.map(project),
    },
    ready_for_human: [...readyForHuman],
    degraded: errors.length > 0,
    errors: [...errors],
  };
}

function withDeadline<T>(promise: Promise<T>, deadline: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), Math.max(0, deadline - Date.now()));
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function partitionReadyForAgentByTrust(
  candidates: readonly IssueCandidate[],
  policy: TrustPolicy,
  deps: {
    issueTrust(candidate: IssueCandidate): Promise<TrustProvenance>;
    actorTrustSignals: ActorTrustLookup;
    trustReadDeadlineMs?: number;
  },
) {
  const deadlineMs = deps.trustReadDeadlineMs ?? 30_000;
  const deadline = Date.now() + deadlineMs;
  const results = await Promise.all(candidates.map(async (candidate) => {
    try {
      const verdict = await withDeadline(
        (async () => evaluateClaimTrust(
          policy,
          await deps.issueTrust(candidate),
          deps.actorTrustSignals,
        ))(),
        deadline,
        `trust read timed out after ${deadlineMs}ms`,
      );
      return { status: "success", candidate, verdict } as const;
    } catch (error) {
      return {
        status: "error",
        candidate,
        error: error instanceof Error ? error.message : String(error),
      } as const;
    }
  }));
  const eligible: IssueCandidate[] = [];
  const heldForSummon: IssueCandidate[] = [];
  const errors: QueueStatusError[] = [];
  for (const result of results) {
    if (result.status === "error") {
      errors.push({ kind: "trust-read", number: result.candidate.number, message: result.error });
    } else {
      (result.verdict.executable ? eligible : heldForSummon).push(result.candidate);
    }
  }
  return { eligible, heldForSummon, errors };
}

describe("queue_status trust partition", () => {
  it("enumerates an all-non-maintainer ready queue as held, not eligible", async () => {
    const candidates: IssueCandidate[] = [
      {
        number: 2062,
        title: "bot-authored canonical ticket",
        body: "maintainer-curated body",
        labels: ["ready-for-agent"],
        author: "github-actions",
      },
    ];
    const policy: TrustPolicy = {
      enabled: false,
      allowlist: [],
      visibility: "public",
      failClosed: true,
    };

    const partition = await partitionReadyForAgentByTrust(candidates, policy, {
      issueTrust: async (candidate) => ({
        author: candidate.author,
        readyForAgentActor: "maintainer",
      }),
      actorTrustSignals: async (actor) => ({
        hasWriteAccess: actor === "maintainer",
        inCodeowners: false,
      }),
    });

    expect(partition.eligible).toEqual([]);
    expect(partition.heldForSummon.map((candidate) => candidate.number)).toEqual([2062]);
  });

  it("keeps successful candidates visible and degrades the queue when a middle trust read fails", async () => {
    const candidates: IssueCandidate[] = [
      { number: 3777, title: "first", body: "", labels: ["ready-for-agent"], author: "maintainer" },
      { number: 3778, title: "middle", body: "", labels: ["ready-for-agent"], author: "maintainer" },
      { number: 3779, title: "last", body: "", labels: ["ready-for-agent"], author: "maintainer" },
    ];
    const policy: TrustPolicy = {
      enabled: false,
      allowlist: [],
      visibility: "public",
      failClosed: true,
    };
    let started = 0;
    let releaseBatch!: () => void;
    const batchStarted = new Promise<void>((resolve) => {
      releaseBatch = resolve;
    });

    const partition = await partitionReadyForAgentByTrust(candidates, policy, {
      issueTrust: async (candidate) => {
        started += 1;
        if (started === candidates.length) releaseBatch();
        await batchStarted;
        if (candidate.number === 3778) throw new Error("trust endpoint unavailable");
        return { author: candidate.author, readyForAgentActor: "maintainer" };
      },
      actorTrustSignals: async () => ({ hasWriteAccess: true, inCodeowners: false }),
    });
    const queue = buildQueueStatus(
      partition.eligible,
      partition.heldForSummon,
      [],
      partition.errors,
    );

    expect(queue.ready_for_agent.eligible.map((candidate) => candidate.number)).toEqual([
      3777,
      3779,
    ]);
    expect(queue.ready_for_agent.held_for_summon).toEqual([]);
    expect(queue.degraded).toBe(true);
    expect(queue.errors).toEqual([
      { kind: "trust-read", number: 3778, message: "trust endpoint unavailable" },
    ]);
  }, 1_000);

  it("bounds the trust batch when one candidate never answers", async () => {
    const candidates: IssueCandidate[] = [
      { number: 3780, title: "answered", body: "", labels: ["ready-for-agent"], author: "maintainer" },
      { number: 3781, title: "stalled", body: "", labels: ["ready-for-agent"], author: "maintainer" },
    ];
    const policy: TrustPolicy = {
      enabled: false,
      allowlist: [],
      visibility: "public",
      failClosed: true,
    };

    const partition = await partitionReadyForAgentByTrust(candidates, policy, {
      issueTrust: async (candidate) => {
        if (candidate.number === 3781) return await new Promise(() => undefined);
        return { author: candidate.author, readyForAgentActor: "maintainer" };
      },
      actorTrustSignals: async () => ({ hasWriteAccess: true, inCodeowners: false }),
      trustReadDeadlineMs: 10,
    });

    expect(partition.eligible.map((candidate) => candidate.number)).toEqual([3780]);
    expect(partition.errors).toEqual([
      { kind: "trust-read", number: 3781, message: "trust read timed out after 10ms" },
    ]);
  }, 500);
});
