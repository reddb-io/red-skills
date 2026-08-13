import { describe, expect, it } from "vitest";
import {
  buildQueueStatus,
  partitionReadyForAgentByTrust,
} from "../src/mcp-adapter.js";
import type { IssueCandidate } from "../src/core/session.js";
import type { TrustPolicy } from "../src/core/trust-gate.js";

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
