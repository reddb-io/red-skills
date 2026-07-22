import { describe, expect, it, vi } from "vitest";
import {
  acquireClaim,
  reconcileClaim,
  refreshClaimHeartbeats,
  renderClaimComment,
  type ClaimGh,
  type RawClaimComment,
} from "../src/core/claim.js";
import { claimHolderVerdict } from "../src/core/claim-staleness.js";

function fakeCommentStore(): ClaimGh & {
  posted: Array<{ issue: number; body: string }>;
  edited: Array<{ commentId: number; body: string }>;
  conceded: Array<{ issue: number; body: string }>;
  seed(issue: number, body: string, createdAt?: string): void;
} {
  const comments = new Map<number, RawClaimComment[]>();
  const posted: Array<{ issue: number; body: string }> = [];
  const edited: Array<{ commentId: number; body: string }> = [];
  const conceded: Array<{ issue: number; body: string }> = [];
  let nextId = 1;
  return {
    posted,
    edited,
    conceded,
    seed(issue, body, createdAt) {
      comments.set(issue, [...(comments.get(issue) ?? []), { id: nextId++, body, createdAt }]);
    },
    async postClaim(issue, body) {
      const id = nextId++;
      posted.push({ issue, body });
      comments.set(issue, [...(comments.get(issue) ?? []), { id, body }]);
      return id;
    },
    async listClaims(issue) {
      return [...(comments.get(issue) ?? [])];
    },
    async editClaim(commentId, body) {
      edited.push({ commentId, body });
      return true;
    },
    async concede(issue, body) {
      conceded.push({ issue, body });
      comments.set(issue, [...(comments.get(issue) ?? []), { id: nextId++, body }]);
    },
  };
}

describe("claim heartbeat maintenance", () => {
  it("refreshes all due holders in one cadence batch without spending quota inside the cadence", async () => {
    const store = fakeCommentStore();
    const clock = vi.fn(() => 1_700_000_000);
    const claims = [
      { issue: 41, worker: "host-a:wA", commentId: 11, lastHeartbeatS: clock() - 270 },
      { issue: 42, worker: "host-a:wB", commentId: 12, lastHeartbeatS: clock() - 400 },
      { issue: 43, worker: "host-a:wC", commentId: 13, lastHeartbeatS: clock() - 269 },
    ];

    const first = await refreshClaimHeartbeats(store, claims, clock(), 270);
    expect(first).toEqual({ refreshed: [41, 42], skipped: [43] });
    expect(store.edited).toHaveLength(2);
    expect(store.edited.map((call) => call.commentId)).toEqual([11, 12]);
    expect(store.posted).toHaveLength(0);

    const second = await refreshClaimHeartbeats(
      store,
      claims.map((claim) =>
        first.refreshed.includes(claim.issue) ? { ...claim, lastHeartbeatS: clock() } : claim,
      ),
      clock(),
      270,
    );
    expect(second).toEqual({ refreshed: [], skipped: [41, 42, 43] });
    expect(store.edited).toHaveLength(2);
    expect(store.posted).toHaveLength(0);
  });

  it("uses process evidence for local holders and heartbeat TTL for remote holders", () => {
    const nowS = 1_700_000_000;
    const staleHeartbeat = {
      commentId: 1,
      worker: "local:wA",
      kind: "claim" as const,
      createdAt: new Date((nowS - 1_081) * 1000).toISOString(),
    };
    const freshHeartbeat = {
      ...staleHeartbeat,
      worker: "remote:wB",
      createdAt: new Date((nowS - 30) * 1000).toISOString(),
    };
    const config = { refreshCadenceS: 270, tolerance: 3 };

    expect(claimHolderVerdict(staleHeartbeat, "local", () => true, nowS, config)).toBe("live");
    expect(claimHolderVerdict({ ...freshHeartbeat, worker: "local:wC" }, "local", () => false, nowS, config)).toBe(
      "evictable",
    );
    expect(claimHolderVerdict(freshHeartbeat, "local", () => false, nowS, config)).toBe("live");
    expect(
      claimHolderVerdict({ ...staleHeartbeat, worker: "remote:wB" }, "local", () => true, nowS, config),
    ).toBe("evictable");
  });

  it("evicts a stale remote owner through a concede-on-behalf marker with heartbeat evidence", async () => {
    const store = fakeCommentStore();
    const lastHeartbeat = "2026-07-22T20:00:00.000Z";
    const nowS = Math.floor(Date.parse(lastHeartbeat) / 1000) + 1_081;
    store.seed(44, renderClaimComment({ worker: "remote:wDead", createdAt: lastHeartbeat }));

    const decision = await acquireClaim(store, { worker: "local:wEvictor" }, 44, {
      isStale: (record) => record.worker === "remote:wDead",
      nowS,
    });

    expect(decision).toMatchObject({ verdict: "won", recovered: ["remote:wDead"] });
    expect(store.conceded).toHaveLength(1);
    expect(store.conceded[0]?.issue).toBe(44);
    expect(store.conceded[0]?.body).toContain("worker=remote:wDead kind=concede reason=stale");
    expect(store.conceded[0]?.body).toContain("by=local:wEvictor");
    expect(store.conceded[0]?.body).toContain(`last-heartbeat=${lastHeartbeat}`);
    expect(store.conceded[0]?.body).toContain("heartbeat-age-s=1081");
    expect(store.conceded[0]?.body).toContain("conceded on behalf");
  });

  it("resolves two evictors by server comment ordering so only the first wins", () => {
    const records = [
      { commentId: 10, worker: "remote:wDead", kind: "claim" as const },
      { commentId: 20, worker: "host-a:wFirst", kind: "claim" as const },
      { commentId: 21, worker: "host-b:wSecond", kind: "claim" as const },
    ];
    const stale = (record: (typeof records)[number]) => record.worker === "remote:wDead";

    expect(
      reconcileClaim(records, { worker: "host-a:wFirst", commentId: 20 }, { isStale: stale }),
    ).toMatchObject({ verdict: "won", recovered: ["remote:wDead"] });
    expect(
      reconcileClaim(records, { worker: "host-b:wSecond", commentId: 21 }, { isStale: stale }),
    ).toMatchObject({ verdict: "lost", winner: "host-a:wFirst", recovered: [] });
  });
});
