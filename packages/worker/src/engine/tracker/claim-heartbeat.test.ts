// Claim heartbeats + TTL eviction for dead remote hosts (#2423).
//
// The federation contract in four pins: a holder refreshes its marker on ONE
// batched fleet cadence (bounded GitHub quota), a remote holder past the TTL is
// evictable while a live LOCAL holder never is (process evidence beats clock
// evidence), an eviction is written through the SAME concede core a holder uses
// to release itself, and two evictors racing are resolved by comment ordering.

import { describe, expect, it } from "vitest";
import {
  acquireClaim,
  parseClaimRecords,
  refreshClaimHeartbeats,
  renderClaimComment,
  renderConcedeOnBehalf,
  type ClaimGh,
  type ClaimHeartbeat,
  type ClaimRecord,
  type RawClaimComment,
} from "./claim.js";
import { claimHolderVerdict, planStaleClaimSweep, staleWindowS } from "./claim-staleness.js";

const CADENCE_S = 270;

/** ISO stamp for an epoch-seconds instant — the injected clock, never wall time. */
function at(epochS: number): string {
  return new Date(epochS * 1000).toISOString();
}

/** A fake GitHub comment store with per-operation call counters, so quota
 * discipline is asserted on COUNTS rather than inferred from behaviour. */
function fakeStore(seed: RawClaimComment[] = []) {
  const comments = seed.slice();
  let nextId = (comments.at(-1)?.id ?? 0) + 1;
  const calls = { post: 0, list: 0, concede: 0, edit: 0 };
  const conceded: string[] = [];
  const gh: Required<Pick<ClaimGh, "editClaim">> & ClaimGh = {
    async postClaim(_issue, body) {
      calls.post += 1;
      const id = nextId++;
      comments.push({ id, body });
      return id;
    },
    async listClaims() {
      calls.list += 1;
      return comments.slice();
    },
    async concede(_issue, body) {
      calls.concede += 1;
      conceded.push(body);
      const id = nextId++;
      comments.push({ id, body });
    },
    async editClaim(commentId, body) {
      calls.edit += 1;
      const target = comments.find((c) => c.id === commentId);
      if (!target) return false;
      target.body = body;
      return true;
    },
  };
  return { gh, comments, calls, conceded };
}

function claimComment(id: number, worker: string, createdAtS: number): RawClaimComment {
  return { id, body: renderClaimComment({ worker, createdAt: at(createdAtS) }, "claim") };
}

// ---- heartbeat refresh + batched cadence ----

describe("refreshClaimHeartbeats", () => {
  const heartbeats = (lastS: number[]): ClaimHeartbeat[] =>
    lastS.map((last, idx) => ({
      issue: 100 + idx,
      worker: `h:w${idx}`,
      commentId: 10 + idx,
      lastHeartbeatS: last,
    }));

  it("refreshes only the claims whose marker is older than the cadence", async () => {
    const nowS = 10_000;
    const store = fakeStore([
      claimComment(10, "h:w0", nowS - CADENCE_S - 1), // due
      claimComment(11, "h:w1", nowS - 5), // fresh
      claimComment(12, "h:w2", nowS - CADENCE_S), // exactly due
    ]);
    const result = await refreshClaimHeartbeats(
      store.gh,
      heartbeats([nowS - CADENCE_S - 1, nowS - 5, nowS - CADENCE_S]),
      nowS,
      CADENCE_S,
    );
    expect(result.refreshed).toEqual([100, 102]);
    expect(result.skipped).toEqual([101]);
  });

  it("spends exactly one API call per DUE claim and none for the rest (quota discipline)", async () => {
    const nowS = 10_000;
    const store = fakeStore([
      claimComment(10, "h:w0", nowS - CADENCE_S - 1),
      claimComment(11, "h:w1", nowS - 5),
      claimComment(12, "h:w2", nowS - 5),
    ]);
    await refreshClaimHeartbeats(
      store.gh,
      heartbeats([nowS - CADENCE_S - 1, nowS - 5, nowS - 5]),
      nowS,
      CADENCE_S,
    );
    // One batch pass over three claims: one edit, and no post/list/concede at all.
    expect(store.calls).toEqual({ post: 0, list: 0, concede: 0, edit: 1 });
  });

  it("refreshes IN PLACE — the marker keeps its server-order id and only its ts moves", async () => {
    const nowS = 10_000;
    const store = fakeStore([claimComment(10, "h:w0", nowS - CADENCE_S - 1)]);
    await refreshClaimHeartbeats(store.gh, heartbeats([nowS - CADENCE_S - 1]), nowS, CADENCE_S);
    const records = parseClaimRecords(store.comments);
    expect(store.comments).toHaveLength(1);
    expect(records[0]?.commentId).toBe(10);
    expect(records[0]?.kind).toBe("claim");
    expect(records[0]?.createdAt).toBe(at(nowS));
  });

  it("records a refused edit as a skip, never as a fresh heartbeat", async () => {
    const nowS = 10_000;
    const store = fakeStore([]); // comment 10 does not exist → editClaim resolves false
    const result = await refreshClaimHeartbeats(store.gh, heartbeats([0]), nowS, CADENCE_S);
    expect(result.refreshed).toEqual([]);
    expect(result.skipped).toEqual([100]);
  });
});

// ---- holder verdicts: local process evidence vs remote heartbeat TTL ----

describe("claimHolderVerdict", () => {
  const nowS = 1_000_000;
  const stale = (worker: string): ClaimRecord => ({
    commentId: 1,
    worker,
    kind: "claim",
    createdAt: at(nowS - staleWindowS() - 1),
  });
  const fresh = (worker: string): ClaimRecord => ({
    commentId: 1,
    worker,
    kind: "claim",
    createdAt: at(nowS - 10),
  });
  const alive = () => true;
  const dead = () => false;

  it("keeps a remote holder whose heartbeat is still inside the window", () => {
    expect(claimHolderVerdict(fresh("remote:w1"), "local", dead, nowS)).toBe("live");
  });

  it("evicts a remote holder whose heartbeat exceeded the TTL", () => {
    expect(claimHolderVerdict(stale("remote:w1"), "local", alive, nowS)).toBe("evictable");
  });

  it("keeps a LOCAL holder with a live pid even when its marker is past the TTL", () => {
    expect(claimHolderVerdict(stale("local:w1"), "local", alive, nowS)).toBe("live");
  });

  it("evicts a LOCAL holder with a dead pid even when its marker is fresh", () => {
    expect(claimHolderVerdict(fresh("local:w1"), "local", dead, nowS)).toBe("evictable");
  });
});

describe("planStaleClaimSweep with local process evidence", () => {
  const nowS = 1_000_000;
  const staleRecords: ClaimRecord[] = [
    { commentId: 1, worker: "local:w1", kind: "claim", createdAt: at(nowS - staleWindowS() - 1) },
  ];

  it("never robs a local holder proven live, however old its marker is", () => {
    const plans = planStaleClaimSweep(
      [{ issue: 7, records: staleRecords, liveOwners: ["local:w1"] }],
      nowS,
    );
    expect(plans).toEqual([]);
  });

  it("releases the same issue once that local holder is no longer proven live", () => {
    const plans = planStaleClaimSweep([{ issue: 7, records: staleRecords }], nowS);
    expect(plans).toEqual([{ issue: 7, staleOwners: ["local:w1"] }]);
  });
});

// ---- eviction goes through the sanctioned concede core ----

describe("concede-on-behalf eviction", () => {
  it("renders the same marker grammar a self-concede uses, plus staleness evidence", () => {
    const body = renderConcedeOnBehalf("dead:w1", "h:evictor", "2026-07-24T00:00:00Z", 1234);
    const [record] = parseClaimRecords([{ id: 9, body }]);
    // Folded by every existing reader as an ordinary withdrawal by the OWNER —
    // no parallel record type, no second mutation path.
    expect(record).toMatchObject({ commentId: 9, worker: "dead:w1", kind: "concede" });
    expect(body).toContain("reason=stale");
    expect(body).toContain("by=h:evictor");
    expect(body).toContain("last-heartbeat=2026-07-24T00:00:00Z");
    expect(body).toContain("heartbeat-age-s=1234");
    expect(body).toContain("conceded on behalf by `h:evictor`");
  });

  it("posts the withdrawal through gh.concede — the existing mutation path — on a TTL recovery", async () => {
    const nowS = 1_000_000;
    const lastHeartbeatS = nowS - staleWindowS() - 60;
    const store = fakeStore([claimComment(1, "dead:remote", lastHeartbeatS)]);
    const decision = await acquireClaim(store.gh, { worker: "h:evictor" }, 5, {
      isStale: (r) => r.worker === "dead:remote",
      nowS,
    });
    expect(decision.verdict).toBe("won");
    expect(decision.recovered).toEqual(["dead:remote"]);
    expect(store.calls.concede).toBe(1);
    expect(store.conceded[0]).toContain("worker=dead:remote kind=concede reason=stale");
    expect(store.conceded[0]).toContain("by=h:evictor");
    expect(store.conceded[0]).toContain(`heartbeat-age-s=${nowS - lastHeartbeatS}`);
  });

  it("writes no withdrawal when nothing was recovered", async () => {
    const store = fakeStore([]);
    const decision = await acquireClaim(store.gh, { worker: "h:evictor" }, 5, { nowS: 1_000_000 });
    expect(decision.verdict).toBe("won");
    expect(store.calls.concede).toBe(0);
  });
});

// ---- two evictors race; comment ordering decides ----

describe("two hosts racing to evict the same stale remote claim", () => {
  it("gives the issue to the earlier claim id and makes the loser concede itself", async () => {
    const nowS = 1_000_000;
    const store = fakeStore([claimComment(1, "dead:remote", nowS - staleWindowS() - 60)]);
    const isStale = (r: ClaimRecord) => r.worker === "dead:remote";

    // Both evictors post before either reads back — the interleaving that makes
    // the race real. GitHub's monotonic ids are the only arbiter.
    const first = acquireClaim(store.gh, { worker: "h1:evictor" }, 5, { isStale, nowS });
    const second = acquireClaim(store.gh, { worker: "h2:evictor" }, 5, { isStale, nowS });
    const [a, b] = await Promise.all([first, second]);

    expect(a.verdict).toBe("won");
    expect(b.verdict).toBe("lost");
    expect(b.winner).toBe("h1:evictor");

    const onBehalf = store.conceded.filter((body) => body.includes("reason=stale"));
    const selfConcede = store.conceded.filter((body) => body.includes("reason=lost"));
    // Exactly one eviction record — the winner's — and the loser withdraws itself.
    expect(onBehalf).toHaveLength(1);
    expect(onBehalf[0]).toContain("by=h1:evictor");
    expect(selfConcede).toHaveLength(1);
    expect(selfConcede[0]).toContain("worker=h2:evictor");
  });
});
