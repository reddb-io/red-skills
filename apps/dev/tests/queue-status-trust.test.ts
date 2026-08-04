import { describe, expect, it } from "vitest";
import { partitionReadyForAgentByTrust } from "../src/mcp-adapter.js";
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
});
