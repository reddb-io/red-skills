// The reserved band, applied where the budget is spent (#3095, ADR 0132
// Amendment 2). Convenience reads are refused once the balance enters the band;
// the claim, a landing and a finishing Worker's closing comment keep passing
// until the pool has nothing left at all. A balance nobody could ask for opens
// the gate rather than closing it.
import { GITHUB_BUDGET_GATE_ENV, parseGithubBalance, type GithubBalance } from "@reddb-io/github";
import { afterEach, describe, expect, it } from "vitest";

import {
  OPEN_GH_BAND_GATE,
  createGhBandGate,
  resolveGhBandGate,
} from "../src/runtime/gh/band.js";
import { forgetGithubBudgetGateMode } from "../src/runtime/gh/budget-gate-config.js";
import { tryReadGhJsonRows } from "../src/runtime/gh/read.js";

const NOW = "2026-08-03T12:00:00.000Z";

function balance(graphqlRemaining: number, restRemaining = 5000): GithubBalance {
  const reset = Math.floor(Date.parse("2026-08-03T13:00:00.000Z") / 1000);
  return parseGithubBalance(
    {
      resources: {
        core: { limit: 5000, remaining: restRemaining, used: 5000 - restRemaining, reset },
        graphql: { limit: 5000, remaining: graphqlRemaining, used: 5000 - graphqlRemaining, reset },
        search: { limit: 30, remaining: 30, used: 0, reset },
      },
    },
    { askedAt: NOW },
  );
}

function gate(answer: GithubBalance | null, reads?: { count: number }) {
  return createGhBandGate({
    readBalance: async () => {
      if (reads) reads.count += 1;
      return answer;
    },
    nowIso: () => NOW,
  });
}

describe("the band refuses convenience, never the claim", () => {
  it("refuses a listing once the balance enters the band", async () => {
    const refusal = await gate(balance(5000, 100)).admit(["issue", "list", "--json", "number"], "convenience");

    expect(refusal).not.toBeNull();
    expect(refusal!.admission.posture).toBe("reserved");
    expect(refusal!.message).toContain("gh issue list");
    expect(refusal!.message).toContain("reserved band");
  });

  it("lets the claim through the same band that refused the listing", async () => {
    const band = gate(balance(100, 100));

    expect(await band.admit(["issue", "comment", "42", "--body", "claim"], "essential")).toBeNull();
    expect(await band.admit(["pr", "merge", "7"], "essential")).toBeNull();
    expect(await band.admit(["issue", "list"], "convenience")).not.toBeNull();
  });

  it("refuses everything once the pool has nothing left, GitHub would too", async () => {
    // `pr merge` rides REST since #3663, so ITS pool is the one that must be dry.
    const refusal = await gate(balance(0, 0)).admit(["pr", "merge", "7"], "essential");

    expect(refusal).not.toBeNull();
    expect(refusal!.admission.posture).toBe("spent");
    expect(refusal!.message).toContain("resets at");
  });

  it("judges each call against ITS pool, not against the roomiest one", async () => {
    // GraphQL inside the band, REST untouched — the exact shape measured twice in
    // one hour, and the shape an average would have called healthy.
    const band = gate(balance(100, 5000));

    expect(await band.admit(["label", "list"], "convenience")).not.toBeNull();
    expect(await band.admit(["issue", "view", "42"], "convenience")).toBeNull();
  });

  it("opens the gate when nothing answered, because blind is not spent", async () => {
    expect(await gate(null).admit(["issue", "list"], "convenience")).toBeNull();
  });

  it("does not refuse an operation nobody classified", async () => {
    expect(await gate(balance(100)).admit(["gist", "list"], "convenience")).toBeNull();
  });

  it("reads the balance once per cadence, not once per call", async () => {
    const reads = { count: 0 };
    const band = gate(balance(4000), reads);

    for (let i = 0; i < 5; i += 1) await band.admit(["issue", "list"], "convenience");

    expect(reads.count).toBe(1);
  });
});

describe("the band is opt-in; the quota belongs to the operator (#3768)", () => {
  const declared = process.env[GITHUB_BUDGET_GATE_ENV];

  afterEach(() => {
    if (declared === undefined) delete process.env[GITHUB_BUDGET_GATE_ENV];
    else process.env[GITHUB_BUDGET_GATE_ENV] = declared;
    forgetGithubBudgetGateMode();
  });

  it("hands back the OPEN gate when nobody asked for the band", () => {
    delete process.env[GITHUB_BUDGET_GATE_ENV];
    forgetGithubBudgetGateMode();
    expect(resolveGhBandGate()).toBe(OPEN_GH_BAND_GATE);
  });

  it("hands back a real gate once the operator declared the band", () => {
    process.env[GITHUB_BUDGET_GATE_ENV] = "on";
    forgetGithubBudgetGateMode();
    expect(resolveGhBandGate()).not.toBe(OPEN_GH_BAND_GATE);
  });

  it("still lets a caller inject its own gate either way", () => {
    expect(resolveGhBandGate(OPEN_GH_BAND_GATE)).toBe(OPEN_GH_BAND_GATE);
  });
});

describe("the read boundary refuses before it spends", () => {
  it("never issues the call it refused", async () => {
    let calls = 0;
    const result = await tryReadGhJsonRows(
      {
        cwd: "/tmp",
        band: gate(balance(5000, 100)),
        exec: async () => {
          calls += 1;
          return { code: 0, stdout: "[]", stderr: "" };
        },
      },
      ["issue", "list", "--json", "number"],
    );

    expect(calls).toBe(0);
    expect(result.outcome).toBe("failed");
    expect(result.outcome === "failed" && result.failure.classification).toBe("reserved");
    // Our posture, never GitHub's refusal: the two must stay distinguishable.
    expect(result.outcome === "failed" && result.failure.transient).toBe(true);
    expect(result.outcome === "failed" && result.failure.code).toBe(-1);
  });

  it("issues the essential call the same band refused a convenience one for", async () => {
    let calls = 0;
    const result = await tryReadGhJsonRows(
      {
        cwd: "/tmp",
        band: gate(balance(5000, 100)),
        criticality: "essential",
        exec: async () => {
          calls += 1;
          return { code: 0, stdout: "[]", stderr: "" };
        },
      },
      ["issue", "list", "--json", "number"],
    );

    expect(calls).toBe(1);
    expect(result.outcome).toBe("rows");
  });

  it("spends nothing differently when the band is open", async () => {
    let calls = 0;
    const result = await tryReadGhJsonRows(
      {
        cwd: "/tmp",
        band: OPEN_GH_BAND_GATE,
        exec: async () => {
          calls += 1;
          return { code: 0, stdout: '[{"number":1}]', stderr: "" };
        },
      },
      ["issue", "list", "--json", "number"],
    );

    expect(calls).toBe(1);
    expect(result.outcome).toBe("rows");
  });
});
