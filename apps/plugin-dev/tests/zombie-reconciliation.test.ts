import { describe, expect, it } from "vitest";

import {
  ZOMBIE_DISPLACEMENTS,
  ZOMBIE_DISPLACEMENT_REASONS,
  detectZombieDisplacements,
  executeZombieReconciliation,
  planZombieReconciliation,
  renderZombieEvidence,
  zombieLandingRefusal,
  zombieSalvageRoute,
  zombieVerdict,
  type ZombieFacts,
  type ZombieReconciliationIO,
  type ZombieWatch,
} from "../src/core/zombie-reconciliation.js";
import { doLanding, harness } from "./landing.test-support.js";

// #4176: a Worker that completes after its claim was released or after the base
// generation moved is reconciled against the current queue state before any of
// its output is accepted. Nothing it produced is landed; the salvage travels
// through a fresh Ticket or an evidenced park.

const OWNER = "host-a:wZ0MB1E";
const OTHER = "host-a:wLIVE";

function watch(overrides: Partial<ZombieWatch> = {}): ZombieWatch {
  return {
    workerId: "wZ0MB1E",
    claimOwner: OWNER,
    activeClaimOwners: [OWNER],
    baseAtStart: "0r1g1nsha",
    issueOpen: true,
    ...overrides,
  };
}

function facts(overrides: Partial<ZombieFacts> = {}): ZombieFacts {
  return {
    ...watch(),
    issue: 4176,
    title: "Zombie reconciliation",
    branch: "afk/wZ0MB1E/4176-zombie",
    headSha: "abcdef0123456789abcdef0123456789abcdef01",
    base: "main",
    baseNow: "0r1g1nsha",
    ...overrides,
  };
}

function recordingIo(): ZombieReconciliationIO & {
  readonly calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    async concede(issue, owner) {
      calls.push(`concede #${issue} ${owner}`);
    },
    async openTicket(ticket) {
      calls.push(`openTicket ${ticket.title}`);
      return 4999;
    },
    async comment(issue, body) {
      calls.push(`comment #${issue} ${body.slice(0, 24)}`);
    },
    async editLabels(issue, remove, add) {
      calls.push(`labels #${issue} -${remove.join(",")} +${add.join(",")}`);
    },
  };
}

describe("detecting a world that moved", () => {
  it("names nothing when the claim is still held and the base has not moved", () => {
    expect(detectZombieDisplacements({ ...watch(), baseNow: "0r1g1nsha" })).toEqual([]);
    expect(zombieVerdict({ ...watch(), baseNow: "0r1g1nsha" })).toEqual({ zombie: false });
  });

  it("names every displacement, not the first", () => {
    const verdict = zombieVerdict({
      ...watch({ activeClaimOwners: [OTHER], concededClaimOwners: [OWNER], issueOpen: false }),
      baseNow: "n3wb4sesha",
    });

    expect(verdict.zombie).toBe(true);
    if (!verdict.zombie) return;
    expect(verdict.displacements).toEqual([
      "claim-released",
      "claim-taken",
      "base-moved",
      "issue-closed",
    ]);
    for (const kind of ZOMBIE_DISPLACEMENTS) {
      expect(verdict.message).toContain(ZOMBIE_DISPLACEMENT_REASONS[kind]);
    }
  });

  it("does not compare a base the caller could not read", () => {
    expect(detectZombieDisplacements({ ...watch(), baseNow: null })).toEqual([]);
  });
});

describe("the landing precondition", () => {
  it("judges nothing when the caller states no watch", async () => {
    let calls = 0;
    const refusal = await zombieLandingRefusal(
      async () => {
        calls += 1;
        return { code: 0, stdout: "", stderr: "" };
      },
      { repoDir: "/repo", remote: "origin", base: "main" },
    );

    expect(refusal).toBeNull();
    expect(calls).toBe(0);
  });

  it("refuses a completion whose claim was released and whose base moved", async () => {
    const refusal = await zombieLandingRefusal(
      async () => ({ code: 0, stdout: "n3wb4sesha\n", stderr: "" }),
      {
        repoDir: "/repo",
        remote: "origin",
        base: "main",
        zombieWatch: watch({ activeClaimOwners: [], concededClaimOwners: [OWNER] }),
      },
    );

    expect(refusal).toContain(ZOMBIE_DISPLACEMENT_REASONS["claim-released"]);
    expect(refusal).toContain(ZOMBIE_DISPLACEMENT_REASONS["base-moved"]);
  });
});

describe("doLanding refuses a zombie completion (#4176)", () => {
  it("lands nothing when the claim was released and the base generation moved", async () => {
    const h = harness({ locked: false });
    const r = await doLanding(
      h.deps,
      {
        ...h.input,
        zombieWatch: watch({
          activeClaimOwners: [],
          concededClaimOwners: [OWNER],
          baseAtStart: "0ldb4sesha",
        }),
      },
      h.hooks,
    );

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("zombie");
    expect(r.message).toContain(ZOMBIE_DISPLACEMENT_REASONS["claim-released"]);
    expect(r.message).toContain(ZOMBIE_DISPLACEMENT_REASONS["base-moved"]);
  });

  it("is the ordinary landing when the world the Worker forked from held", async () => {
    const h = harness({ locked: false });
    const r = await doLanding(h.deps, { ...h.input, zombieWatch: watch() }, h.hooks);

    expect(r.ok).toBe(true);
  });
});

describe("where the salvage is addressed", () => {
  it("parks the original Ticket with the evidence when it is still open and unheld", async () => {
    const plan = planZombieReconciliation(
      facts({ activeClaimOwners: [], concededClaimOwners: [OWNER], baseNow: "n3wb4sesha" }),
    );

    expect(plan).not.toBeNull();
    if (plan == null) return;
    expect(plan.landing).toBe("refused");
    expect(plan.salvage).toBe("evidenced-park");
    expect(plan.ticket).toBeUndefined();
    expect(plan.park?.transition).toEqual({ kind: "human" });
    expect(plan.park?.currentLabels).toEqual(["running", "ready-for-agent"]);
    expect(plan.park?.comment).toContain("afk/wZ0MB1E/4176-zombie");
    expect(plan.park?.comment).toContain("abcdef012345");
    expect(plan.concede).toBeNull();
  });

  it("mints a reconciliation Ticket when the original is closed or claimed by another Worker", () => {
    expect(zombieSalvageRoute(["claim-released"])).toBe("evidenced-park");
    expect(zombieSalvageRoute(["issue-closed"])).toBe("reconciliation-ticket");
    expect(zombieSalvageRoute(["claim-taken"])).toBe("reconciliation-ticket");

    const plan = planZombieReconciliation(facts({ issueOpen: false }));

    expect(plan?.salvage).toBe("reconciliation-ticket");
    expect(plan?.park).toBeUndefined();
    expect(plan?.ticket?.title).toContain("#4176");
    expect(plan?.ticket?.body).toContain("nothing was landed");
    expect(plan?.ticket?.body).toContain("afk/wZ0MB1E/4176-zombie");
    // The Worker still holds its claim on a closed Ticket, so it is withdrawn.
    expect(plan?.concede).toBe(OWNER);
  });

  it("plans nothing for a completion whose world did not move", () => {
    expect(planZombieReconciliation(facts())).toBeNull();
  });

  it("leads the evidence with where the work is", () => {
    const evidence = renderZombieEvidence(
      facts({ activeClaimOwners: [OTHER], baseNow: "n3wb4sesha", issueOpen: false }),
    );

    expect(evidence.startsWith("branch=`afk/wZ0MB1E/4176-zombie`")).toBe(true);
    expect(evidence).toContain("origin/main 0r1g1nsha → n3wb4sesha");
    expect(evidence).toContain(OTHER);
    expect(evidence).toContain("the Ticket is closed");
  });
});

describe("executing one reconciliation", () => {
  it("mints the Ticket, points the original at it, and lands nothing", async () => {
    const plan = planZombieReconciliation(facts({ activeClaimOwners: [OWNER, OTHER] }))!;
    const io = recordingIo();

    const result = await executeZombieReconciliation(plan, io);

    expect(result.landed).toBe(false);
    expect(result.salvage).toBe("reconciliation-ticket");
    expect(result.reconciliationIssue).toBe(4999);
    expect(io.calls[0]).toBe(`concede #4176 ${OWNER}`);
    expect(io.calls[1]).toContain("openTicket Reconcile salvaged work from #4176");
    expect(io.calls[2]).toContain("comment #4176");
  });

  it("withdraws the claim before the labels move on a park", async () => {
    const plan = planZombieReconciliation(facts({ baseNow: "n3wb4sesha" }))!;
    const io = recordingIo();

    const result = await executeZombieReconciliation(plan, io);

    expect(result.landed).toBe(false);
    expect(result.parkedIssue).toBe(4176);
    expect(io.calls).toEqual([
      `concede #4176 ${OWNER}`,
      "labels #4176 -ready-for-agent,running +ready-for-human",
      expect.stringContaining("comment #4176"),
    ]);
  });

  it("reports a write it could not perform instead of throwing", async () => {
    const plan = planZombieReconciliation(facts({ baseNow: "n3wb4sesha" }))!;
    const io = recordingIo();
    const result = await executeZombieReconciliation(plan, {
      ...io,
      async editLabels() {
        throw new Error("the tracker refused");
      },
    });

    expect(result.landed).toBe(false);
    expect(result.failure).toBe("the tracker refused");
  });
});
