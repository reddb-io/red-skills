// The claim never dams, and a Worker that cannot write one declines the issue
// (#3095, ADR 0132 Amendment 2).
//
// Claiming is three layers: the local `mkdir` lock, the GitHub claim marker, and
// the stale-lock boot sweep. Damming the middle layer — by a breaker, by a
// reserved band, or by a write that simply fails — leaves only the host-local
// lock. That is safe on one machine and admits two Workers on one branch the
// moment a second host drains the same backlog, which is exactly the failure a
// single-machine test can never observe.
import { parseGithubBalance, type GithubBalance } from "@reddb-io/github";
import { describe, expect, it } from "vitest";

import { processIssue } from "../src/core/process-issue.js";
import { createGhBandGate } from "../src/runtime/gh/band.js";
import { harness } from "./process-issue.test-helpers.js";

const NOW = "2026-08-03T12:00:00.000Z";

function bandAt(remaining: number): GithubBalance {
  const reset = Math.floor(Date.parse("2026-08-03T13:00:00.000Z") / 1000);
  return parseGithubBalance(
    {
      resources: {
        core: { limit: 5000, remaining, used: 5000 - remaining, reset },
        graphql: { limit: 5000, remaining, used: 5000 - remaining, reset },
        search: { limit: 30, remaining: 30, used: 0, reset },
      },
    },
    { askedAt: NOW },
  );
}

function gate(balance: GithubBalance) {
  return createGhBandGate({
    readBalance: async () => balance,
    nowIso: () => NOW,
  });
}

describe("a Worker that cannot claim declines the issue", () => {
  it("declines rather than proceeding on the host-local lock alone", async () => {
    const { deps, input, trace } = harness({ claim: { winner: "self" } });
    deps.claimGh = {
      async postClaim() {
        throw new Error("gh issue comment failed: the claim marker never landed");
      },
      async listClaims() {
        return [];
      },
      async concede() {},
    };

    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("claim-lost");
    // No agent ran, nothing was pushed: declining means declining.
    expect(trace.pushedAttempt).toEqual([]);
  });

  it("releases the local lock it took, rather than stranding it", async () => {
    const { deps, input, trace } = harness({ claim: { winner: "self" } });
    deps.claimGh = {
      async postClaim() {
        throw new Error("the claim marker never landed");
      },
      async listClaims() {
        return [];
      },
      async concede() {},
    };

    await processIssue(deps, input);

    expect(trace.released).toContain(input.issue);
  });

  it("says WHY in the iteration log, not merely that the claim was lost", async () => {
    const { deps, input, trace } = harness({ claim: { winner: "self" } });
    deps.claimGh = {
      async postClaim() {
        throw new Error("HTTP 502 from the comments endpoint");
      },
      async listClaims() {
        return [];
      },
      async concede() {},
    };

    await processIssue(deps, input);

    const logged = trace.iterLogs.join("\n");
    expect(logged).toContain("claim could not be written");
    expect(logged).toContain("HTTP 502");
  });
});

describe("the reserved band never dams the claim", () => {
  it("admits the claim's write inside the band that refuses a listing", async () => {
    const band = gate(bandAt(100));

    expect(await band.admit(["issue", "comment", "42", "--body", "<!-- afk:claim -->"], "essential")).toBeNull();
    expect(await band.admit(["issue", "list", "--json", "number"], "convenience")).not.toBeNull();
  });

  it("admits the claim's read-back too, because a write nobody verifies is not a claim", async () => {
    const band = gate(bandAt(100));

    expect(await band.admit(["issue", "view", "42", "--json", "comments"], "essential")).toBeNull();
  });

  it("admits a landing inside the band", async () => {
    const band = gate(bandAt(100));

    expect(await band.admit(["pr", "merge", "7", "--squash"], "essential")).toBeNull();
    expect(await band.admit(["pr", "comment", "7", "--body", "landed"], "essential")).toBeNull();
  });
});
