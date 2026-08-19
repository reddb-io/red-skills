import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLAIM_REFRESH_S,
  DEFAULT_CLAIM_REAPER_GRACE_S,
  DEFAULT_CLAIM_RECENT_COMMIT_PROTECTION_S,
  DEFAULT_CLAIM_STALE_TOLERANCE,
  DEFAULT_CLAIM_STALENESS,
  classifyClaim,
  classifyIssueClaims,
  makeStaleClaimPredicate,
  planStaleClaimSweep,
  resolveClaimReaperConfig,
  resolveClaimStalenessConfig,
  staleWindowS,
  type ClaimReaperConfig,
  type ClaimStalenessConfig,
} from "../src/core/claim-staleness.js";
import type { ClaimRecord } from "../src/core/claim.js";

// A claim record whose owner last refreshed at ISO `ts` (epoch seconds → ISO).
function recAt(epochS: number, worker = "dead:host"): ClaimRecord {
  return { commentId: 1, worker, kind: "claim", createdAt: new Date(epochS * 1000).toISOString() };
}

// A claim record at `commentId` from `worker`, last-refreshed `ageS` ago.
function claimAt(commentId: number, worker: string, ageS: number, nowS = T0): ClaimRecord {
  return {
    commentId,
    worker,
    kind: "claim",
    createdAt: new Date((nowS - ageS) * 1000).toISOString(),
  };
}

const T0 = 1_700_000_000; // a fixed injected clock anchor (epoch seconds)

describe("staleWindowS", () => {
  it("is cadence × (tolerance + 1) — comfortably exceeds the refresh cadence", () => {
    const cfg: ClaimStalenessConfig = { refreshCadenceS: 270, tolerance: 3 };
    expect(staleWindowS(cfg)).toBe(1080);
    // The window strictly exceeds the cadence for any tolerance ≥ 0.
    expect(staleWindowS(cfg)).toBeGreaterThan(cfg.refreshCadenceS);
    expect(staleWindowS({ refreshCadenceS: 60, tolerance: 0 })).toBe(60);
  });

  it("defaults to 270 × 4 = 1080s", () => {
    expect(staleWindowS()).toBe(DEFAULT_CLAIM_REFRESH_S * (DEFAULT_CLAIM_STALE_TOLERANCE + 1));
    expect(DEFAULT_CLAIM_REFRESH_S).toBe(270);
    expect(staleWindowS(DEFAULT_CLAIM_STALENESS)).toBe(1080);
  });
});

describe("classifyClaim (pure, injected clock)", () => {
  const cfg: ClaimReaperConfig = {
    refreshCadenceS: 270,
    tolerance: 3,
    claimGraceS: 270,
    recentCommitProtectionS: 2700,
  };

  it("a just-refreshed claim is fresh", () => {
    expect(classifyClaim(recAt(T0), T0, cfg)).toBe("fresh");
  });

  it("a claim within the window (missed a few refreshes) is still fresh — never robbed", () => {
    // 900s old < 1080s window: missed 3 refreshes, tolerated.
    expect(classifyClaim(recAt(T0 - 900), T0, cfg)).toBe("fresh");
  });

  it("a claim exactly at the window boundary is fresh (inclusive)", () => {
    expect(classifyClaim(recAt(T0 - 1080), T0, cfg)).toBe("fresh");
  });

  it("a claim past the window is stale — owner presumed dead, recoverable", () => {
    expect(classifyClaim(recAt(T0 - 1081), T0, cfg)).toBe("stale");
    expect(classifyClaim(recAt(T0 - 99999), T0, cfg)).toBe("stale");
  });

  it("a claim with no timestamp is fresh (unknown age never robs)", () => {
    expect(classifyClaim({ commentId: 1, worker: "h:w", kind: "claim" }, T0, cfg)).toBe("fresh");
  });

  it("a claim with an unparseable timestamp is fresh", () => {
    expect(classifyClaim({ commentId: 1, worker: "h:w", kind: "claim", createdAt: "not-a-date" }, T0, cfg)).toBe(
      "fresh",
    );
  });

  it("a future-dated claim (clock skew) is fresh, never stale", () => {
    expect(classifyClaim(recAt(T0 + 5000), T0, cfg)).toBe("fresh");
  });
});

describe("makeStaleClaimPredicate", () => {
  it("returns true only for records past the window — the reconciler's isStale seam", () => {
    const isStale = makeStaleClaimPredicate(T0, { refreshCadenceS: 270, tolerance: 3 });
    expect(isStale(recAt(T0 - 100))).toBe(false);
    expect(isStale(recAt(T0 - 5000))).toBe(true);
    expect(isStale({ commentId: 9, worker: "h:w", kind: "claim" })).toBe(false);
  });
});

describe("resolveClaimStalenessConfig", () => {
  it("defaults when env is empty", () => {
    expect(resolveClaimStalenessConfig({})).toEqual(DEFAULT_CLAIM_STALENESS);
  });

  it("reads RED_AFK_CLAIM_REFRESH_S and RED_AFK_CLAIM_STALE_TOLERANCE", () => {
    expect(
      resolveClaimStalenessConfig({ RED_AFK_CLAIM_REFRESH_S: "1200", RED_AFK_CLAIM_STALE_TOLERANCE: "5" }),
    ).toEqual({ refreshCadenceS: 1200, tolerance: 5 });
  });

  it("tolerates a zero tolerance (window = exactly one cadence)", () => {
    const cfg = resolveClaimStalenessConfig({ RED_AFK_CLAIM_STALE_TOLERANCE: "0" });
    expect(cfg.tolerance).toBe(0);
    expect(staleWindowS(cfg)).toBe(DEFAULT_CLAIM_REFRESH_S);
  });

  it("falls back to the default cadence on a non-positive / non-numeric value — never robs", () => {
    expect(resolveClaimStalenessConfig({ RED_AFK_CLAIM_REFRESH_S: "0" }).refreshCadenceS).toBe(
      DEFAULT_CLAIM_REFRESH_S,
    );
    expect(resolveClaimStalenessConfig({ RED_AFK_CLAIM_REFRESH_S: "abc" }).refreshCadenceS).toBe(
      DEFAULT_CLAIM_REFRESH_S,
    );
  });
});

describe("resolveClaimReaperConfig", () => {
  it("defaults to the staleness policy plus explicit reaper guard thresholds", () => {
    expect(resolveClaimReaperConfig({})).toEqual({
      ...DEFAULT_CLAIM_STALENESS,
      claimGraceS: DEFAULT_CLAIM_REAPER_GRACE_S,
      recentCommitProtectionS: DEFAULT_CLAIM_RECENT_COMMIT_PROTECTION_S,
    });
  });

  it("reads env overrides before plugins.dev.afk.* config values", () => {
    const cfg = (key: string) =>
      ({
        "afk.claim_reaper.grace_s": "600",
        "afk.claim_reaper.recent_commit_s": "1800",
      })[key] ?? "";
    expect(resolveClaimReaperConfig({ RED_AFK_CLAIM_REAPER_GRACE_S: "120" }, cfg)).toMatchObject({
      claimGraceS: 120,
      recentCommitProtectionS: 1800,
    });
  });

  it("falls back on non-positive / non-numeric guard overrides", () => {
    const cfg = (key: string) =>
      ({
        "afk.claim_reaper.grace_s": "0",
        "afk.claim_reaper.recent_commit_s": "abc",
      })[key] ?? "";
    expect(resolveClaimReaperConfig({}, cfg)).toMatchObject({
      claimGraceS: DEFAULT_CLAIM_REAPER_GRACE_S,
      recentCommitProtectionS: DEFAULT_CLAIM_RECENT_COMMIT_PROTECTION_S,
    });
  });
});

describe("classifyIssueClaims", () => {
  const isStale = makeStaleClaimPredicate(T0, { refreshCadenceS: 270, tolerance: 3 });

  it("a single fresh claim is the live owner, no stale owners", () => {
    const st = classifyIssueClaims([claimAt(10, "live:host", 60)], isStale);
    expect(st).toEqual({ liveOwner: "live:host", staleOwners: [], concededOwners: [] });
  });

  it("a single aged-out claim has no live owner and one stale owner", () => {
    const st = classifyIssueClaims([claimAt(10, "dead:host", 9999)], isStale);
    expect(st).toEqual({ liveOwner: null, staleOwners: ["dead:host"], concededOwners: [] });
  });

  it("a live contender holds the issue even when an older claim went stale", () => {
    const st = classifyIssueClaims(
      [claimAt(10, "dead:host", 9999), claimAt(20, "live:host", 30)],
      isStale,
    );
    expect(st.liveOwner).toBe("live:host");
    expect(st.staleOwners).toEqual(["dead:host"]);
  });

  it("the earliest live claim wins as the owner", () => {
    const st = classifyIssueClaims(
      [claimAt(30, "b:host", 30), claimAt(10, "a:host", 30)],
      isStale,
    );
    expect(st.liveOwner).toBe("a:host");
  });

  it("a worker that conceded after a stale claim is not counted", () => {
    const records: ClaimRecord[] = [
      claimAt(10, "gone:host", 9999),
      { commentId: 40, worker: "gone:host", kind: "concede" },
    ];
    const st = classifyIssueClaims(records, isStale);
    expect(st).toEqual({ liveOwner: null, staleOwners: [], concededOwners: ["gone:host"] });
  });
});

describe("planStaleClaimSweep", () => {
  const cfg: ClaimReaperConfig = {
    refreshCadenceS: 270,
    tolerance: 3,
    claimGraceS: 270,
    recentCommitProtectionS: 2700,
  };

  it("releases an issue held only by a stale claim", () => {
    const releases = planStaleClaimSweep(
      [{ issue: 7, records: [claimAt(10, "dead:host", 9999)] }],
      T0,
      cfg,
    );
    expect(releases).toEqual([{ issue: 7, staleOwners: ["dead:host"] }]);
  });

  it("never releases an issue with a live owner — a slow worker is not robbed", () => {
    const releases = planStaleClaimSweep(
      [{ issue: 7, records: [claimAt(10, "live:host", 200)] }],
      T0,
      cfg,
    );
    expect(releases).toEqual([]);
  });

  it("never releases when a live claim coexists with a stale one", () => {
    const releases = planStaleClaimSweep(
      [{ issue: 7, records: [claimAt(10, "dead:host", 9999), claimAt(20, "live:host", 30)] }],
      T0,
      cfg,
    );
    expect(releases).toEqual([]);
  });

  it("releases only the dead-held issues across a mixed set", () => {
    const releases = planStaleClaimSweep(
      [
        { issue: 1, records: [claimAt(10, "dead:1", 9999)] },
        { issue: 2, records: [claimAt(10, "live:2", 30)] },
        { issue: 3, records: [claimAt(10, "dead:3", 5000)] },
        { issue: 4, records: [] },
      ],
      T0,
      cfg,
    );
    expect(releases).toEqual([
      { issue: 1, staleOwners: ["dead:1"] },
      { issue: 3, staleOwners: ["dead:3"] },
    ]);
  });

  it("never releases a claim inside the explicit grace period, even with an aggressive stale window", () => {
    const releases = planStaleClaimSweep(
      [{ issue: 7, records: [claimAt(10, "fresh:host", 200)] }],
      T0,
      { refreshCadenceS: 60, tolerance: 0, claimGraceS: 300, recentCommitProtectionS: 2700 },
    );
    expect(releases).toEqual([]);
  });

  it("releases a dead-owner claim immediately, regardless of age grace", () => {
    const releases = planStaleClaimSweep(
      [{ issue: 7, records: [claimAt(10, "dead:host", 30)], deadOwners: ["dead:host"] }],
      T0,
      cfg,
    );
    expect(releases).toEqual([{ issue: 7, staleOwners: ["dead:host"] }]);
  });

  it("never releases a stale claim whose attempt branch has a recent commit", () => {
    const releases = planStaleClaimSweep(
      [
        {
          issue: 7,
          records: [claimAt(10, "live-work:host", 9999)],
          attemptBranchCommitS: T0 - 120,
        },
      ],
      T0,
      cfg,
    );
    expect(releases).toEqual([]);
  });

  it("does not let recent branch commits protect a dead-owner claim", () => {
    const releases = planStaleClaimSweep(
      [
        {
          issue: 7,
          records: [claimAt(10, "dead:host", 30)],
          deadOwners: ["dead:host"],
          attemptBranchCommitS: T0 - 10,
        },
      ],
      T0,
      cfg,
    );
    expect(releases).toEqual([{ issue: 7, staleOwners: ["dead:host"] }]);
  });

  it("still releases a stale claim when no commit landed inside the protection window", () => {
    const releases = planStaleClaimSweep(
      [
        {
          issue: 7,
          records: [claimAt(10, "dead:host", 9999)],
          attemptBranchCommitS: T0 - cfg.recentCommitProtectionS - 1,
        },
      ],
      T0,
      cfg,
    );
    expect(releases).toEqual([{ issue: 7, staleOwners: ["dead:host"] }]);
  });

  it("repairs a running-label contradiction when every latest claim marker conceded", () => {
    const releases = planStaleClaimSweep(
      [
        {
          issue: 9,
          records: [
            claimAt(10, "gone:host", 30),
            { commentId: 20, worker: "gone:host", kind: "concede" },
          ],
          attemptBranchCommitS: T0 - 10,
        },
      ],
      T0,
      cfg,
    );
    expect(releases).toEqual([{ issue: 9, staleOwners: [], concededOwners: ["gone:host"] }]);
  });
});
