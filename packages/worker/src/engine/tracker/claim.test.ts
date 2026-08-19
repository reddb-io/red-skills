import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  acquireClaim,
  acquireIssueLease,
  ClaimVerificationError,
  createFsIssueLeaseStore,
  parseClaimRecords,
  reconcileClaim,
  renderClaimComment,
  renderRecoveryAudit,
  retireIssueLease,
  type ClaimGh,
  type ClaimRecord,
  type ClaimSelf,
  type RawClaimComment,
  type TrackerClaimLiveness,
  type TrackerClaimStore,
} from "./claim.js";
import { CLAIM_WIRE_FIXTURES } from "./claim-wire-fixture.js";

// A claim record at `id` from `worker` (claim unless kind given).
function rec(commentId: number, worker: string, kind: "claim" | "concede" = "claim"): ClaimRecord {
  return { commentId, worker, kind };
}

function self(worker: string, commentId: number): ClaimSelf {
  return { worker, commentId };
}

// ---- pinned wire format ----

describe("claim wire fixtures", () => {
  it.each(CLAIM_WIRE_FIXTURES.map((f) => [f.name, f] as const))(
    "parses %s",
    (_name, fixture) => {
      expect(parseClaimRecords([fixture.comment])).toEqual(fixture.expected);
    },
  );

  it("pins the render output literally — a change here is a wire-format decision", () => {
    expect(
      renderClaimComment(
        { worker: "host:w1", runner: "claude", createdAt: "2026-06-10T23:10:24Z" },
        "claim",
      ),
    ).toBe(
      "<!-- afk:claim v1 worker=host:w1 kind=claim runner=claude ts=2026-06-10T23:10:24Z -->\n" +
        "🤖 AFK claim by worker `host:w1` (runner `claude`).",
    );
    expect(renderClaimComment({ worker: "host:w1" }, "concede", "lost")).toBe(
      "<!-- afk:claim v1 worker=host:w1 kind=concede reason=lost -->\n" +
        "🤖 AFK worker `host:w1` conceded this issue (lost the claim race to an earlier claimant).",
    );
    expect(renderClaimComment({ worker: "host:w1" }, "concede", "released")).toBe(
      "<!-- afk:claim v1 worker=host:w1 kind=concede reason=released -->\n" +
        "🤖 AFK worker `host:w1` conceded this issue (released the claim it held).",
    );
    expect(renderClaimComment({ worker: "host:w1" }, "concede")).toBe(
      "<!-- afk:claim v1 worker=host:w1 kind=concede -->\n" +
        "🤖 AFK worker `host:w1` conceded this issue (lost the claim race or released).",
    );
  });

  it("round-trips every render variant through the parser", () => {
    for (const kind of ["claim", "concede"] as const) {
      for (const reason of [undefined, "lost", "released", "unspecified"] as const) {
        const body = renderClaimComment(
          { worker: "h:w", runner: "codex", createdAt: "2026-07-01T00:00:00Z" },
          kind,
          reason,
        );
        const [record] = parseClaimRecords([{ id: 9, body }]);
        expect(record).toMatchObject({
          commentId: 9,
          worker: "h:w",
          kind,
          runner: "codex",
          createdAt: "2026-07-01T00:00:00Z",
        });
      }
    }
  });
});

// ---- marker layer ----

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
    expect(r?.createdAt).toBe("2026-06-10T00:00:00Z");
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

// ---- reconciler layer ----

describe("reconcileClaim interleavings", () => {
  it("solo win: only our own claim contends", () => {
    const d = reconcileClaim([], self("h:me", 100));
    expect(d).toMatchObject({ verdict: "won", winner: "h:me" });
    expect(d.reason).toBe("solo claim");
  });

  it("same-host duel: two workers on one host, lowest comment id wins", () => {
    const records = [rec(50, "host:a"), rec(60, "host:b")];
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
    const records = [
      { ...rec(50, "other:host"), createdAt: "2026-07-07T03:08:14Z" },
      rec(200, "h:me"),
    ];
    const d = reconcileClaim(records, self("h:me", 200));
    expect(d.verdict).toBe("lost");
    expect(d.winner).toBe("other:host");
    expect(d.winnerClaimId).toBe(50);
    expect(d.winnerCreatedAt).toBe("2026-07-07T03:08:14Z");
  });

  it("a flapping claimant cannot jump the queue by re-claiming", () => {
    const records = [rec(10, "other"), rec(90, "other"), rec(50, "h:me")];
    expect(reconcileClaim(records, self("h:me", 50)).verdict).toBe("lost");
  });

  it("conceded earlier winner drops out: the next-earliest live claim wins", () => {
    const records = [rec(10, "other"), rec(80, "other", "concede"), rec(50, "h:me")];
    const d = reconcileClaim(records, self("h:me", 50));
    expect(d.verdict).toBe("won");
    expect(d.winner).toBe("h:me");
  });

  it("our own concede (latest word) means we no longer contend", () => {
    const records = [rec(50, "h:me"), rec(90, "h:me", "concede")];
    const d = reconcileClaim(records, self("h:me", 50));
    expect(d.verdict).toBe("lost");
  });
});

describe("reconcileClaim stale-claim recovery (injected liveness)", () => {
  it("recovers a dead cross-host winner via isStale", () => {
    const records = [rec(10, "dead:host"), rec(50, "h:me")];
    expect(reconcileClaim(records, self("h:me", 50)).verdict).toBe("lost");
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

  it("appends a predecessor death cause when deathFor resolves one", () => {
    const out = renderRecoveryAudit({ worker: "h:me" }, ["h:dead"], (w) =>
      w === "h:dead" ? "uncatchable death (likely SIGKILL/OOM)" : null,
    );
    expect(out).toContain("stopped refreshing"); // base wording preserved
    expect(out).toContain("Predecessor cause (process-safety diagnostic)");
    expect(out).toContain("`h:dead`: uncatchable death (likely SIGKILL/OOM)");
  });

  it("pluralizes and joins multiple resolved causes, skipping the unresolved", () => {
    const out = renderRecoveryAudit({ worker: "h:me" }, ["h:a", "h:b", "other:c"], (w) =>
      w === "h:a" ? "clean exit (code 1)" : w === "h:b" ? "terminated by SIGTERM" : null,
    );
    expect(out).toContain("Predecessor causes (process-safety diagnostic)");
    expect(out).toContain("`h:a`: clean exit (code 1)");
    expect(out).toContain("`h:b`: terminated by SIGTERM");
    expect(out).not.toContain("`other:c`:");
  });

  it("keeps the original wording when deathFor is absent or resolves nothing", () => {
    const noLookup = renderRecoveryAudit({ worker: "h:me" }, ["h:dead"]);
    expect(noLookup).not.toContain("Predecessor cause");
    const allNull = renderRecoveryAudit({ worker: "h:me" }, ["h:dead"], () => null);
    expect(allNull).not.toContain("Predecessor cause");
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
    const gh = fakeGh([{ id: 1, body: renderClaimComment({ worker: "dead:host" }) }]);
    const d = await acquireClaim(gh, { worker: "h:me", runner: "claude" }, 5, {
      isStale: (r) => r.worker === "dead:host",
    });
    expect(d.verdict).toBe("won");
    expect(d.recovered).toEqual(["dead:host"]);
    expect(gh.audited).toHaveLength(1);
    expect(gh.audited[0]).toContain("cross-host recovery");
    expect(gh.audited[0]).toContain("dead:host");
    // The recovery ALSO withdraws the dead owner through the sanctioned concede
    // path, so the marker layer records who evicted whom (#2423).
    expect(gh.conceded).toHaveLength(1);
    expect(gh.conceded[0]).toContain("worker=dead:host kind=concede reason=stale");
    expect(gh.conceded[0]).toContain("by=h:me");
  });

  it("posts no audit comment on an ordinary solo win", async () => {
    const gh = fakeGh([]);
    const d = await acquireClaim(gh, { worker: "h:me" }, 5);
    expect(d.verdict).toBe("won");
    expect(gh.audited).toHaveLength(0);
  });
});

// ---- sole claimant on a freshly minted issue (#2385) ----
//
// Three `/go` dispatches in a row claimed the issue the engine had just minted,
// immediately conceded it with no other claimant present, and reported success
// over zero work. The claim substrate must make that verdict unreachable: a sole
// claimant always wins its own mint, and an unverifiable claim fails loudly.
describe("sole-claimant verification (#2385)", () => {
  it("wins its own freshly minted issue even when the staleness predicate rejects everything", () => {
    const d = reconcileClaim([], self("h:me", 10), { isStale: () => true });
    expect(d.verdict).toBe("won");
    expect(d.winner).toBe("h:me");
  });

  it("still loses to a live earlier claimant while self is stale-exempt", () => {
    const d = reconcileClaim([rec(5, "other:host")], self("h:me", 10), {
      isStale: (r) => r.worker === "h:me",
    });
    expect(d.verdict).toBe("lost");
    expect(d.winner).toBe("other:host");
  });

  it("throws instead of conceding when our own claim id is unusable", () => {
    expect(() => reconcileClaim([], self("h:me", Number.NaN))).toThrow(ClaimVerificationError);
  });

  it("retries the read-back until our claim marker is visible", async () => {
    const gh = fakeGh([]);
    const real = gh.listClaims.bind(gh);
    let calls = 0;
    gh.listClaims = async (issue: number) => {
      calls += 1;
      return calls < 3 ? [] : real(issue); // eventual consistency after the POST
    };
    const slept: number[] = [];
    const d = await acquireClaim(gh, { worker: "h:me" }, 5, {
      sleep: async (ms) => void slept.push(ms),
    });
    expect(d.verdict).toBe("won");
    expect(calls).toBe(3);
    expect(slept).toHaveLength(2);
    expect(gh.conceded).toHaveLength(0);
  });

  it("keeps the verified fresh claim alive when pre-boot liveness rejects its marker", async () => {
    const gh = fakeGh([]);
    const d = await acquireClaim(gh, { worker: "h:me" }, 5, {
      isStale: (record) => record.worker === "h:me",
    });

    expect(d).toMatchObject({ verdict: "won", winner: "h:me" });
    expect(gh.conceded).toHaveLength(0);
  });

  it("fails loudly — never 'lost' — when the read-back never shows our claim", async () => {
    const gh = fakeGh([]);
    gh.listClaims = async () => []; // e.g. every `gh api` list call failed
    await expect(
      acquireClaim(gh, { worker: "h:me" }, 5, { sleep: async () => undefined }),
    ).rejects.toBeInstanceOf(ClaimVerificationError);
    expect(gh.conceded).toHaveLength(0);
  });

  // #4049: an empty read-back is a read that cannot be believed, not a race.
  it("classifies an always-empty read-back as an infrastructure failure", async () => {
    const gh = fakeGh([]);
    gh.listClaims = async () => []; // a cache serving the list from before our POST
    const error = await acquireClaim(gh, { worker: "h:me" }, 5, {
      sleep: async () => undefined,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClaimVerificationError);
    expect((error as ClaimVerificationError).kind).toBe("infrastructure");
    expect((error as Error).message).toMatch(/cannot be believed rather than a lost race/);
    expect(gh.conceded).toHaveLength(0);
  });

  it("keeps a populated-but-stale read-back classified as propagation", async () => {
    const gh = fakeGh([]);
    // Someone else's marker is visible, ours is not yet: an ordinary race we
    // waited too little for, and the one case where conceding is meaningful.
    gh.listClaims = async () => [
      {
        id: 987_654,
        body: renderClaimComment({ worker: "h:other" }, "claim"),
        createdAt: "2026-08-19T00:00:00Z",
      },
    ];
    const error = await acquireClaim(gh, { worker: "h:me" }, 5, {
      sleep: async () => undefined,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClaimVerificationError);
    expect((error as ClaimVerificationError).kind).toBe("propagation");
    expect(gh.conceded).toHaveLength(0);
  });

  it("fails loudly when every read-back attempt throws", async () => {
    const gh = fakeGh([]);
    gh.listClaims = async () => {
      throw new Error("gh api: network unreachable");
    };
    await expect(
      acquireClaim(gh, { worker: "h:me" }, 5, { sleep: async () => undefined }),
    ).rejects.toThrow(/network unreachable/);
    expect(gh.conceded).toHaveLength(0);
  });
});

// ---- concede wording (#2385) ----
describe("concede reason wording", () => {
  it("names the lost race distinctly from a voluntary release", () => {
    const lost = renderClaimComment({ worker: "h:me" }, "concede", "lost");
    const released = renderClaimComment({ worker: "h:me" }, "concede", "released");
    expect(lost).toContain("reason=lost");
    expect(lost).toContain("lost the claim race to an earlier claimant");
    expect(released).toContain("reason=released");
    expect(released).toContain("released the claim it held");
    expect(released).not.toContain("lost the claim race");
  });

  it("keeps the legacy ambiguous wording when no reason is supplied", () => {
    const legacy = renderClaimComment({ worker: "h:me" }, "concede");
    expect(legacy).toContain("lost the claim race or released");
    expect(legacy).not.toContain("reason=");
  });

  it("parses a reason-bearing concede marker as a concede", () => {
    const [record] = parseClaimRecords([
      { id: 7, body: renderClaimComment({ worker: "h:me" }, "concede", "released") },
    ]);
    expect(record?.kind).toBe("concede");
    expect(record?.worker).toBe("h:me");
  });
});

// ---- local FS lease composition (castle-only layer) ----

function memoryStore(
  existing: RawClaimComment[] = [],
): TrackerClaimStore & {
  posted: string[];
  conceded: string[];
} {
  let nextId = (existing.at(-1)?.id ?? 0) + 1;
  const posted: string[] = [];
  const conceded: string[] = [];
  return {
    posted,
    conceded,
    async postClaim(_issue, body) {
      posted.push(body);
      existing.push({ id: nextId, body });
      return nextId++;
    },
    async listClaims() {
      return existing.slice();
    },
    async concede(_issue, body) {
      conceded.push(body);
      existing.push({ id: nextId++, body });
    },
  };
}

async function tempLeaseRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "red-castle-tracker-claim-"));
}

describe("tracker dual lease", () => {
  it("acquires the local mkdir lease before posting the ADR 0066 claim marker", async () => {
    const root = await tempLeaseRoot();
    try {
      const local = createFsIssueLeaseStore(root);
      const store = memoryStore();

      const decision = await acquireIssueLease({
        issue: 1907,
        identity: { worker: "host:w1", runner: "codex" },
        local,
        remote: store,
        liveness: () => "unknown",
      });

      expect(decision).toMatchObject({ verdict: "won", winner: "host:w1" });
      await expect(readFile(join(root, "1907", "owner"), "utf8")).resolves.toBe(
        "host:w1\n",
      );
      expect(store.posted[0]).toContain(
        "<!-- afk:claim v1 worker=host:w1 kind=claim runner=codex -->",
      );
      expect(
        parseClaimRecords(await store.listClaims(1907)),
      ).toMatchObject([{ worker: "host:w1", kind: "claim" }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not steal a local mkdir lease unless supervisor liveness says dead", async () => {
    const root = await tempLeaseRoot();
    try {
      await mkdir(join(root, "1907"), { recursive: true });
      await writeFile(join(root, "1907", "owner"), "host:other\n");
      const local = createFsIssueLeaseStore(root);
      const store = memoryStore();

      const blocked = await acquireIssueLease({
        issue: 1907,
        identity: { worker: "host:w1" },
        local,
        remote: store,
        liveness: () => "alive",
      });

      expect(blocked).toMatchObject({
        verdict: "lost",
        winner: "host:other",
        reason: "local lease owner is alive",
      });
      expect(store.posted).toHaveLength(0);
      await expect(readFile(join(root, "1907", "owner"), "utf8")).resolves.toBe(
        "host:other\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks a DIFFERENT owner from the same pid — the owner token is the identity authority", async () => {
    // One process hosts many workers (the supervisor claims in-process on
    // behalf of each), so a matching pid with a different owner token is a
    // peer's live lease, never an idempotent re-acquire.
    const root = await tempLeaseRoot();
    try {
      const local = createFsIssueLeaseStore(root);
      const store = memoryStore();

      const first = await acquireIssueLease({
        issue: 1907,
        identity: { worker: "host:wA" },
        local,
        remote: store,
        liveness: () => "alive",
      });
      const collision = await acquireIssueLease({
        issue: 1907,
        identity: { worker: "host:wB" },
        local,
        remote: store,
        liveness: () => "alive",
      });

      expect(first).toMatchObject({ verdict: "won", winner: "host:wA" });
      expect(collision).toMatchObject({
        verdict: "lost",
        winner: "host:wA",
        reason: "local lease owner is alive",
      });
      await expect(readFile(join(root, "1907", "owner"), "utf8")).resolves.toBe(
        "host:wA\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers an older remote claim only from an injected dead liveness verdict", async () => {
    const oldClaim = {
      id: 1,
      body: renderClaimComment({ worker: "host:dead" }, "claim"),
      createdAt: "2000-01-01T00:00:00Z",
    };
    const liveStore = memoryStore([oldClaim]);
    const liveRoot = await tempLeaseRoot();
    try {
      const liveDecision = await acquireIssueLease({
        issue: 1907,
        identity: { worker: "host:w1" },
        local: createFsIssueLeaseStore(liveRoot),
        remote: liveStore,
        liveness: () => "alive",
      });
      expect(liveDecision).toMatchObject({
        verdict: "lost",
        winner: "host:dead",
      });
      expect(liveStore.conceded).toHaveLength(1);
      // A lost race concedes with the distinct #2385 reason.
      expect(liveStore.conceded[0]).toContain("reason=lost");
      // The lost race also released the local lease.
      await expect(
        readFile(join(liveRoot, "1907", "owner"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(liveRoot, { recursive: true, force: true });
    }

    const deadStore = memoryStore([oldClaim]);
    const deadRoot = await tempLeaseRoot();
    try {
      const deadDecision = await acquireIssueLease({
        issue: 1907,
        identity: { worker: "host:w1" },
        local: createFsIssueLeaseStore(deadRoot),
        remote: deadStore,
        liveness: (worker) => (worker === "host:dead" ? "dead" : "alive"),
      });
      expect(deadDecision).toMatchObject({
        verdict: "won",
        winner: "host:w1",
        recovered: ["host:dead"],
      });
    } finally {
      await rm(deadRoot, { recursive: true, force: true });
    }
  });

  it("graceful retirement concedes the remote claim and releases the local lease", async () => {
    const root = await tempLeaseRoot();
    try {
      const local = createFsIssueLeaseStore(root);
      const store = memoryStore();
      await acquireIssueLease({
        issue: 1907,
        identity: { worker: "host:w1", runner: "codex" },
        local,
        remote: store,
        liveness: () => "unknown",
      });

      await retireIssueLease({
        issue: 1907,
        identity: { worker: "host:w1", runner: "codex" },
        local,
        remote: store,
      });

      expect(store.conceded).toHaveLength(1);
      expect(store.conceded[0]).toContain("kind=concede");
      // A voluntary retirement names its reason (#2385), never the lost race.
      expect(store.conceded[0]).toContain("reason=released");
      await expect(
        readFile(join(root, "1907", "owner"), "utf8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("releases the local lease when claim verification fails loudly (#2385)", async () => {
    const root = await tempLeaseRoot();
    try {
      const local = createFsIssueLeaseStore(root);
      const store = memoryStore();
      store.listClaims = async () => []; // read-back never shows our marker

      await expect(
        acquireIssueLease({
          issue: 1907,
          identity: { worker: "host:w1" },
          local,
          remote: store,
          liveness: () => "unknown",
          sleep: async () => undefined,
        }),
      ).rejects.toBeInstanceOf(ClaimVerificationError);
      // The dispatch failed loudly, but the host slot is not stranded.
      await expect(
        readFile(join(root, "1907", "owner"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// The FS lease store rebuilt on dev's mkdir-lock semantics (#434 atomic claim,
// #568 atomic-rename recovery). Assertions ported from apps/plugin-dev/tests/fs-sweep.test.ts.
describe("createFsIssueLeaseStore (dev mkdir-lock semantics)", () => {
  const DEAD_PID = 999999;
  // pid predicate: only DEAD_PID is dead; every other pid is treated as alive.
  const pidAlive = (p: number): TrackerClaimLiveness => (p === DEAD_PID ? "dead" : "alive");
  const unknownOwner = (): TrackerClaimLiveness => "unknown";

  it("grants the claim once and writes BOTH pid (no newline) and owner files", async () => {
    const root = await tempLeaseRoot();
    try {
      const store = createFsIssueLeaseStore(root, { pid: 4321, pidAlive });
      const decision = await store.acquire(430, "host:w1", unknownOwner);
      expect(decision).toEqual({ acquired: true });
      expect(await readFile(join(root, "430", "pid"), "utf8")).toBe("4321");
      expect(await readFile(join(root, "430", "owner"), "utf8")).toBe("host:w1\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("denies a second live claimant on the same issue (EEXIST → alive → blocked)", async () => {
    const root = await tempLeaseRoot();
    try {
      const holder = createFsIssueLeaseStore(root, { pid: 1001, pidAlive });
      const other = createFsIssueLeaseStore(root, { pid: 1002, pidAlive });
      expect(await holder.acquire(430, "host:w1", unknownOwner)).toEqual({ acquired: true });
      expect(await other.acquire(430, "host:w2", unknownOwner)).toMatchObject({
        acquired: false,
        owner: "host:w1",
        reason: "local lease owner is alive",
      });
      // The loser must not overwrite the holder's pid.
      expect(await readFile(join(root, "430", "pid"), "utf8")).toBe("1001");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lets exactly ONE of N concurrent live claimers win the same issue (dup-PR race)", async () => {
    const root = await tempLeaseRoot();
    try {
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          createFsIssueLeaseStore(root, { pid: 2001 + i, pidAlive }).acquire(
            936,
            `host:w${i}`,
            unknownOwner,
          ),
        ),
      );
      expect(results.filter((r) => r.acquired)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("self-heals a stale dead-pid dir before acquiring (atomic-rename steal)", async () => {
    const root = await tempLeaseRoot();
    try {
      await mkdir(join(root, "431"), { recursive: true });
      await writeFile(join(root, "431", "pid"), String(DEAD_PID));
      await writeFile(join(root, "431", "owner"), "host:dead\n");
      const store = createFsIssueLeaseStore(root, { pid: 7, pidAlive });
      const decision = await store.acquire(431, "host:w1", unknownOwner);
      expect(decision).toMatchObject({ acquired: true, previousOwner: "host:dead" });
      expect(await readFile(join(root, "431", "pid"), "utf8")).toBe("7");
      expect(await readFile(join(root, "431", "owner"), "utf8")).toBe("host:w1\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lets exactly ONE of N concurrent claimers win when RECLAIMING a stale dir (#568)", async () => {
    const root = await tempLeaseRoot();
    try {
      await mkdir(join(root, "568"), { recursive: true });
      await writeFile(join(root, "568", "pid"), String(DEAD_PID));
      await writeFile(join(root, "568", "owner"), "host:dead\n");
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          createFsIssueLeaseStore(root, { pid: 3001 + i, pidAlive }).acquire(
            568,
            `host:w${i}`,
            unknownOwner,
          ),
        ),
      );
      expect(results.filter((r) => r.acquired)).toHaveLength(1);
      // The single winner's pid is the one left on disk.
      const winnerPid = 3001 + results.findIndex((r) => r.acquired);
      expect(await readFile(join(root, "568", "pid"), "utf8")).toBe(String(winnerPid));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not remove a live existing claim while another claimant probes", async () => {
    const root = await tempLeaseRoot();
    try {
      await mkdir(join(root, "432"), { recursive: true });
      await writeFile(join(root, "432", "pid"), "1234");
      await writeFile(join(root, "432", "owner"), "host:live\n");
      const store = createFsIssueLeaseStore(root, { pid: 4242, pidAlive });
      expect(await store.acquire(432, "host:w1", unknownOwner)).toMatchObject({
        acquired: false,
        reason: "local lease owner is alive",
      });
      expect(await readFile(join(root, "432", "pid"), "utf8")).toBe("1234");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reclaims a poisoned non-directory lease path by replacing it", async () => {
    const root = await tempLeaseRoot();
    try {
      await writeFile(join(root, "433"), "not a lease directory");
      const store = createFsIssueLeaseStore(root, { pid: 55, pidAlive });
      expect(await store.acquire(433, "host:w1", unknownOwner)).toMatchObject({ acquired: true });
      expect(await readFile(join(root, "433", "pid"), "utf8")).toBe("55");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("owner-only legacy dir defers ENTIRELY to injected owner liveness", async () => {
    const root = await tempLeaseRoot();
    try {
      await mkdir(join(root, "700"), { recursive: true });
      await writeFile(join(root, "700", "owner"), "host:other\n"); // no pid file
      // alive owner → blocked
      const blocked = await createFsIssueLeaseStore(root, { pid: 9, pidAlive }).acquire(
        700,
        "host:w1",
        (w) => (w === "host:other" ? "alive" : "unknown"),
      );
      expect(blocked).toMatchObject({ acquired: false, reason: "local lease owner is alive" });
      // dead owner → recovered
      const won = await createFsIssueLeaseStore(root, { pid: 9, pidAlive }).acquire(
        700,
        "host:w1",
        (w) => (w === "host:other" ? "dead" : "unknown"),
      );
      expect(won).toMatchObject({ acquired: true, previousOwner: "host:other" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("pid-only legacy dir (dev format) blocks on live pid and reclaims a dead one", async () => {
    const liveRoot = await tempLeaseRoot();
    const deadRoot = await tempLeaseRoot();
    try {
      await mkdir(join(liveRoot, "8"), { recursive: true });
      await writeFile(join(liveRoot, "8", "pid"), "1234"); // no owner file, alive
      expect(
        await createFsIssueLeaseStore(liveRoot, { pid: 9, pidAlive }).acquire(8, "host:w1", unknownOwner),
      ).toMatchObject({ acquired: false, owner: "1234", reason: "local lease owner is alive" });

      await mkdir(join(deadRoot, "8"), { recursive: true });
      await writeFile(join(deadRoot, "8", "pid"), String(DEAD_PID)); // no owner file, dead
      expect(
        await createFsIssueLeaseStore(deadRoot, { pid: 9, pidAlive }).acquire(8, "host:w1", unknownOwner),
      ).toMatchObject({ acquired: true, previousOwner: String(DEAD_PID) });
    } finally {
      await rm(liveRoot, { recursive: true, force: true });
      await rm(deadRoot, { recursive: true, force: true });
    }
  });

  it("treats a blank/corrupt dir (neither file readable) as reclaimable", async () => {
    const root = await tempLeaseRoot();
    try {
      await mkdir(join(root, "12"), { recursive: true });
      await writeFile(join(root, "12", "pid"), "   "); // blank
      const store = createFsIssueLeaseStore(root, { pid: 77, pidAlive });
      expect(await store.acquire(12, "host:w1", unknownOwner)).toMatchObject({ acquired: true });
      expect(await readFile(join(root, "12", "pid"), "utf8")).toBe("77");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("is idempotent for the same owner and refreshes a missing file", async () => {
    const root = await tempLeaseRoot();
    try {
      const store = createFsIssueLeaseStore(root, { pid: 88, pidAlive });
      expect(await store.acquire(430, "host:w1", unknownOwner)).toEqual({ acquired: true });
      // owner-token idempotence even from a different pid.
      const again = createFsIssueLeaseStore(root, { pid: 999, pidAlive });
      expect(await again.acquire(430, "host:w1", unknownOwner)).toEqual({ acquired: true });
      // Missing owner file is refreshed on a same-pid re-acquire.
      await rm(join(root, "430", "owner"), { force: true });
      expect(await store.acquire(430, "host:w1", unknownOwner)).toEqual({ acquired: true });
      expect(await readFile(join(root, "430", "owner"), "utf8")).toBe("host:w1\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("release is ownership-guarded: removes ours, spares a mismatched live owner", async () => {
    const root = await tempLeaseRoot();
    try {
      const store = createFsIssueLeaseStore(root, { pid: 100, pidAlive });
      await store.acquire(430, "host:w1", unknownOwner);
      // Wrong owner → left alone.
      await store.release(430, "host:someone-else");
      expect(await readFile(join(root, "430", "owner"), "utf8")).toBe("host:w1\n");
      // Right owner → removed.
      await store.release(430, "host:w1");
      await expect(readFile(join(root, "430", "owner"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      // Already gone → no throw.
      await expect(store.release(430, "host:w1")).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("release falls back to the recorded pid when the owner file is absent", async () => {
    const root = await tempLeaseRoot();
    try {
      await mkdir(join(root, "9"), { recursive: true });
      await writeFile(join(root, "9", "pid"), "100"); // dev-format dir, no owner
      const store = createFsIssueLeaseStore(root, { pid: 100, pidAlive });
      await store.release(9, "host:w1");
      await expect(readFile(join(root, "9", "pid"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
