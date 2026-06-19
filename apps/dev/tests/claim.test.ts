import { describe, expect, it } from "vitest";
import {
  acquireClaim,
  parseClaimRecords,
  reconcileClaim,
  renderClaimComment,
  renderRecoveryAudit,
  type ClaimGh,
  type ClaimRecord,
  type ClaimSelf,
  type RawClaimComment,
} from "../src/core/claim.js";

// A claim record at `id` from `worker` (claim unless kind given).
function rec(commentId: number, worker: string, kind: "claim" | "concede" = "claim"): ClaimRecord {
  return { commentId, worker, kind };
}

function self(worker: string, commentId: number): ClaimSelf {
  return { worker, commentId };
}

describe("claim marker round-trip", () => {
  it("renders a parseable claim marker carrying the worker identity", () => {
    const body = renderClaimComment({ worker: "mbp.local:w6HSO-3", runner: "claude" }, "claim");
    expect(body).toContain("<!-- afk:claim v1 worker=mbp.local:w6HSO-3 kind=claim runner=claude -->");
    const parsed = parseClaimRecords([{ id: 42, body }]);
    expect(parsed).toEqual([
      { commentId: 42, worker: "mbp.local:w6HSO-3", kind: "claim", runner: "claude", createdAt: undefined },
    ]);
  });

  it("renders a concede marker", () => {
    const body = renderClaimComment({ worker: "h:w" }, "concede");
    expect(parseClaimRecords([{ id: 7, body }])[0]).toMatchObject({ kind: "concede", worker: "h:w" });
  });

  it("falls back to the comment createdAt when the marker omits ts", () => {
    const body = renderClaimComment({ worker: "h:w" });
    const [r] = parseClaimRecords([{ id: 1, body, createdAt: "2026-06-10T00:00:00Z" }]);
    expect(r.createdAt).toBe("2026-06-10T00:00:00Z");
  });
});

describe("parseClaimRecords garbage tolerance", () => {
  it("skips non-marker comments, malformed markers, and worker-less markers", () => {
    const comments: RawClaimComment[] = [
      { id: 1, body: "just a normal human comment, no marker" },
      { id: 2, body: "<!-- afk:claim v1 kind=claim -->\nmissing worker" },
      { id: 3, body: "<!-- afk:claim worker=h:good kind=claim -->\nok" },
      { id: 4, body: "<!-- afk:somethingelse worker=h:nope -->" },
      // non-numeric id is dropped defensively
      { id: NaN, body: "<!-- afk:claim worker=h:bad -->" },
    ];
    const parsed = parseClaimRecords(comments);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ commentId: 3, worker: "h:good" });
  });

  it("a decision survives a thread full of garbage around one real claim", () => {
    const comments: RawClaimComment[] = [
      { id: 10, body: "lgtm" },
      { id: 11, body: renderClaimComment({ worker: "h:me" }) },
      { id: 12, body: "<!-- afk:claim total garbage no equals -->" },
      { id: 13, body: "" },
    ];
    const decision = reconcileClaim(parseClaimRecords(comments), self("h:me", 11));
    expect(decision.verdict).toBe("won");
  });
});

describe("reconcileClaim interleavings", () => {
  it("solo win: only our own claim contends", () => {
    const d = reconcileClaim([], self("h:me", 100));
    expect(d).toMatchObject({ verdict: "won", winner: "h:me" });
    expect(d.reason).toBe("solo claim");
  });

  it("same-host duel: two workers on one host, lowest comment id wins", () => {
    const records = [rec(50, "host:a"), rec(60, "host:b")];
    // a is the earliest claim → a wins, b loses
    expect(reconcileClaim(records, self("host:a", 50)).verdict).toBe("won");
    const bLost = reconcileClaim(records, self("host:b", 60));
    expect(bLost.verdict).toBe("lost");
    expect(bLost.winner).toBe("host:a");
  });

  it("cross-host duel: earliest server-assigned id wins regardless of host", () => {
    const records = [rec(70, "hostA:w1"), rec(65, "hostB:w9")];
    expect(reconcileClaim(records, self("hostB:w9", 65)).verdict).toBe("won");
    expect(reconcileClaim(records, self("hostA:w1", 70)).verdict).toBe("lost");
  });

  it("late-arrival concede: a worker whose claim id is higher loses to the earlier claim", () => {
    // We post and GitHub gives us id 200, but an earlier active claim (id 50) exists.
    const records = [rec(50, "other:host"), rec(200, "h:me")];
    const d = reconcileClaim(records, self("h:me", 200));
    expect(d.verdict).toBe("lost");
    expect(d.winner).toBe("other:host");
  });

  it("a flapping claimant cannot jump the queue by re-claiming", () => {
    // other claimed first at id 10, re-posts at id 90; we claimed at id 50.
    const records = [rec(10, "other"), rec(90, "other"), rec(50, "h:me")];
    // other's order key is its EARLIEST claim (10) → other still wins.
    expect(reconcileClaim(records, self("h:me", 50)).verdict).toBe("lost");
  });

  it("conceded earlier winner drops out: the next-earliest live claim wins", () => {
    // other had the earliest claim (10) but conceded at 80; we hold id 50.
    const records = [rec(10, "other"), rec(80, "other", "concede"), rec(50, "h:me")];
    const d = reconcileClaim(records, self("h:me", 50));
    expect(d.verdict).toBe("won");
    expect(d.winner).toBe("h:me");
  });

  it("our own concede (latest word) means we no longer contend", () => {
    const records = [rec(50, "h:me"), rec(90, "h:me", "concede")];
    // self is merged back as a claim at self.commentId; but the latest marker for
    // h:me is the concede at 90, so we are not contending → lost.
    const d = reconcileClaim(records, self("h:me", 50));
    expect(d.verdict).toBe("lost");
  });
});

describe("reconcileClaim stale-claim recovery (injected liveness)", () => {
  it("recovers a dead cross-host winner via isStale", () => {
    const records = [rec(10, "dead:host"), rec(50, "h:me")];
    // Without staleness, dead:host wins.
    expect(reconcileClaim(records, self("h:me", 50)).verdict).toBe("lost");
    // Inject staleness for the dead worker → we win.
    const d = reconcileClaim(records, self("h:me", 50), {
      isStale: (r) => r.worker === "dead:host",
    });
    expect(d.verdict).toBe("won");
    expect(d.winner).toBe("h:me");
  });

  it("never marks ourselves stale away from a win we hold", () => {
    const records = [rec(50, "h:me")];
    const d = reconcileClaim(records, self("h:me", 50), { isStale: () => false });
    expect(d.verdict).toBe("won");
  });

  it("reports the recovered stale worker that out-ordered us (#627 audit input)", () => {
    const records = [rec(10, "dead:host"), rec(50, "h:me")];
    const d = reconcileClaim(records, self("h:me", 50), { isStale: (r) => r.worker === "dead:host" });
    expect(d.verdict).toBe("won");
    expect(d.recovered).toEqual(["dead:host"]);
  });

  it("does not report a stale claim posted AFTER our claim as recovered", () => {
    // dead:host's earliest claim (id 80) is LATER than ours (id 50): it never
    // held the issue, so superseding it is not a recovery.
    const records = [rec(50, "h:me"), rec(80, "dead:host")];
    const d = reconcileClaim(records, self("h:me", 50), { isStale: (r) => r.worker === "dead:host" });
    expect(d.verdict).toBe("won");
    expect(d.recovered).toEqual([]);
  });

  it("reports no recovery when we lose", () => {
    const records = [rec(10, "live:host"), rec(20, "dead:host"), rec(50, "h:me")];
    const d = reconcileClaim(records, self("h:me", 50), { isStale: (r) => r.worker === "dead:host" });
    expect(d.verdict).toBe("lost");
    expect(d.winner).toBe("live:host");
    expect(d.recovered).toEqual([]);
  });

  it("the returning stale owner concedes — the staleness predicate resolves the race", () => {
    // B (h:me) recovered A (dead:host) and now holds the live claim. When A
    // returns and reconciles WITHOUT refreshing, its own latest marker is still
    // stale, so A is dropped and B (the live claim) wins — A concedes. This is
    // the race resolved by the claim primitive itself.
    const records = [rec(10, "dead:host"), rec(50, "h:me")];
    const fromOwner = reconcileClaim(records, self("dead:host", 10), {
      isStale: (r) => r.worker === "dead:host",
    });
    expect(fromOwner.verdict).toBe("lost");
    expect(fromOwner.winner).toBe("h:me");
  });
});

describe("renderRecoveryAudit", () => {
  it("names the releasing worker and the recovered claimants", () => {
    const one = renderRecoveryAudit({ worker: "h:me" }, ["dead:host"]);
    expect(one).toContain("h:me");
    expect(one).toContain("dead:host");
    expect(one).toContain("a stale claim");
    const many = renderRecoveryAudit({ worker: "h:me" }, ["a:1", "b:2"]);
    expect(many).toContain("stale claims");
    expect(many).toContain("`a:1`, `b:2`");
  });
});

// ---- orchestrator (injected IO) ----

function fakeGh(
  existing: RawClaimComment[],
): ClaimGh & { posted: string[]; conceded: string[]; audited: string[] } {
  let nextId = (existing.at(-1)?.id ?? 0) + 1;
  const posted: string[] = [];
  const conceded: string[] = [];
  const audited: string[] = [];
  return {
    posted,
    conceded,
    audited,
    async postClaim(_issue, body) {
      const id = nextId++;
      posted.push(body);
      existing.push({ id, body });
      return id;
    },
    async listClaims() {
      return existing.slice();
    },
    async concede(_issue, body) {
      conceded.push(body);
    },
    async audit(_issue, body) {
      audited.push(body);
    },
  };
}

describe("acquireClaim orchestration", () => {
  it("wins solo and posts no concede", async () => {
    const gh = fakeGh([]);
    const d = await acquireClaim(gh, { worker: "h:me", runner: "claude" }, 5);
    expect(d.verdict).toBe("won");
    expect(gh.posted).toHaveLength(1);
    expect(gh.conceded).toHaveLength(0);
  });

  it("loses to an earlier claim and concedes cleanly", async () => {
    // An earlier claim already sits at id 1; our post gets id 2.
    const gh = fakeGh([{ id: 1, body: renderClaimComment({ worker: "other:host" }) }]);
    const d = await acquireClaim(gh, { worker: "h:me", runner: "claude" }, 5);
    expect(d.verdict).toBe("lost");
    expect(d.winner).toBe("other:host");
    expect(gh.conceded).toHaveLength(1);
    expect(gh.conceded[0]).toContain("conceded");
  });

  it("suppressConcede skips the concede side effect", async () => {
    const gh = fakeGh([{ id: 1, body: renderClaimComment({ worker: "other:host" }) }]);
    const d = await acquireClaim(gh, { worker: "h:me" }, 5, { suppressConcede: true });
    expect(d.verdict).toBe("lost");
    expect(gh.conceded).toHaveLength(0);
  });

  it("recovers a stale cross-host claim and posts exactly one audit comment (#627)", async () => {
    // A dead worker holds an earlier claim (id 1); our post gets id 2. We win
    // only because the staleness predicate drops the dead claim — and one audit
    // comment records the recovery.
    const gh = fakeGh([{ id: 1, body: renderClaimComment({ worker: "dead:host" }) }]);
    const d = await acquireClaim(gh, { worker: "h:me", runner: "claude" }, 5, {
      isStale: (r) => r.worker === "dead:host",
    });
    expect(d.verdict).toBe("won");
    expect(d.recovered).toEqual(["dead:host"]);
    expect(gh.audited).toHaveLength(1);
    expect(gh.audited[0]).toContain("cross-host recovery");
    expect(gh.audited[0]).toContain("dead:host");
    expect(gh.conceded).toHaveLength(0);
  });

  it("posts no audit comment on an ordinary solo win", async () => {
    const gh = fakeGh([]);
    const d = await acquireClaim(gh, { worker: "h:me" }, 5);
    expect(d.verdict).toBe("won");
    expect(gh.audited).toHaveLength(0);
  });
});
