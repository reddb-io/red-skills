import { describe, expect, it } from "vitest";
import {
  formatCacheAge,
  formatRspTickerValue,
  humanizeAlive,
  humanizeCount,
  humanizeTokens,
  shortModel,
  renderAfkBlock,
  renderContextBlock,
  renderFleetBlock,
  renderUnlandedDocsBlock,
  renderModelBlock,
  renderProjectBlock,
  renderRepoBlock,
  renderStatusline,
  renderStatuslineWithPreset,
  renderUsageBlock,
  type AfkInput,
  type StatuslineInput,
} from "../src/core/statusline.js";

const baseAfk = (over: Partial<AfkInput> = {}): AfkInput => ({
  workers: 1,
  queue: 11,
  human: 3,
  blocked: 2,
  added: 12,
  removed: 3,
  issues: [17],
  ...over,
});

describe("statusline — formatCacheAge", () => {
  it("renders Xs for ages under one minute", () => {
    expect(formatCacheAge(45)).toBe("45s");
    expect(formatCacheAge(0)).toBe("0s");
    expect(formatCacheAge(59)).toBe("59s");
  });

  it("renders Xm for whole minutes", () => {
    expect(formatCacheAge(60)).toBe("1m");
    expect(formatCacheAge(720)).toBe("12m");
  });

  it("renders XhYm when minutes remain past a full hour", () => {
    expect(formatCacheAge(3900)).toBe("1h5m");
    expect(formatCacheAge(3660)).toBe("1h1m");
  });

  it("renders Xh for whole hours", () => {
    expect(formatCacheAge(3600)).toBe("1h");
    expect(formatCacheAge(7200)).toBe("2h");
  });
});

describe("statusline — fleet block", () => {
  it("renders the supervisor bundle version when present", () => {
    expect(renderFleetBlock({
      runner: "codex",
      busy: 0,
      total: 2,
      queue: 4,
      bundleVersion: "2.61.0",
    })).toBe("flt=codex 0/2 @2.61.0 q=4");
  });

  it("marks fleet bundle skew against the latest cached bundle", () => {
    expect(renderFleetBlock({
      runner: "codex",
      busy: 0,
      total: 2,
      queue: 4,
      bundleVersion: "2.60.2",
      latestBundleVersion: "2.61.0",
    })).toBe("flt=codex 0/2 @2.60.2!<2.61.0 q=4");
  });

  it("marks fleet bundle skew against the stable pointer even when lane newest matches", () => {
    expect(renderFleetBlock({
      runner: "codex",
      busy: 0,
      total: 2,
      queue: 4,
      bundleVersion: "2.63.0",
      pointerVersion: "2.64.0",
      latestBundleVersion: "2.64.0",
    })).toBe("flt=codex 0/2 @2.63.0!<2.64.0 q=4");
  });
});

describe("statusline — humanizeAlive", () => {
  it("renders seconds when under one minute", () => {
    expect(humanizeAlive(30 * 1000)).toBe("30s");
    expect(humanizeAlive(59 * 1000 + 999)).toBe("59s");
  });

  it("always shows seconds at minute scale, even when zero", () => {
    expect(humanizeAlive(5 * 60 * 1000)).toBe("5m0s");
    expect(humanizeAlive(60 * 1000)).toBe("1m0s");
  });

  it("renders XmYs when seconds remain under an hour", () => {
    expect(humanizeAlive((5 * 60 + 40) * 1000)).toBe("5m40s");
    expect(humanizeAlive((1 * 60 + 1) * 1000)).toBe("1m1s");
  });

  it("always shows minutes at hour scale, even when zero", () => {
    expect(humanizeAlive(1 * 60 * 60 * 1000)).toBe("1h0m");
    expect(humanizeAlive(2 * 60 * 60 * 1000)).toBe("2h0m");
  });

  it("renders XhYm when minutes remain", () => {
    expect(humanizeAlive((1 * 60 * 60 + 22 * 60) * 1000)).toBe("1h22m");
    expect(humanizeAlive((1 * 60 * 60 + 1 * 60) * 1000)).toBe("1h1m");
  });

  it("drops the seconds part at hour scale", () => {
    expect(humanizeAlive((1 * 60 * 60 + 22 * 60 + 45) * 1000)).toBe("1h22m");
  });

  it("always shows hours at day scale, even when zero", () => {
    expect(humanizeAlive(24 * 60 * 60 * 1000)).toBe("1d0h");
    expect(humanizeAlive((25 * 60 * 60 + 30 * 60) * 1000)).toBe("1d1h");
    expect(humanizeAlive((2 * 24 * 60 * 60 + 10 * 60 * 60) * 1000)).toBe("2d10h");
  });

  it("renders 0s for zero or negative input", () => {
    expect(humanizeAlive(0)).toBe("0s");
    expect(humanizeAlive(-5000)).toBe("0s");
  });
});

describe("statusline — humanizeTokens", () => {
  it("renders X.XM at or above one million", () => {
    expect(humanizeTokens(1500000)).toBe("1.5M");
  });

  it("renders integer-division Xk at or above one thousand", () => {
    expect(humanizeTokens(47000)).toBe("47k");
    expect(humanizeTokens(47999)).toBe("47k");
  });

  it("renders the raw integer below one thousand", () => {
    expect(humanizeTokens(512)).toBe("512");
  });
});

describe("statusline — humanizeCount (issue #1175)", () => {
  it("renders the raw integer below one thousand", () => {
    expect(humanizeCount(0)).toBe("0");
    expect(humanizeCount(100)).toBe("100");
    expect(humanizeCount(999)).toBe("999");
  });

  it("renders the k tier with at most one decimal, stripping a trailing .0", () => {
    expect(humanizeCount(1000)).toBe("1k");
    expect(humanizeCount(1200)).toBe("1.2k");
    expect(humanizeCount(45000)).toBe("45k");
    expect(humanizeCount(100000)).toBe("100k");
  });

  it("renders the M tier, stripping a trailing .0", () => {
    expect(humanizeCount(1000000)).toBe("1M");
    expect(humanizeCount(1100000)).toBe("1.1M");
    expect(humanizeCount(100000000)).toBe("100M");
  });

  it("renders the B tier", () => {
    expect(humanizeCount(1000000000)).toBe("1B");
    expect(humanizeCount(2300000000)).toBe("2.3B");
  });
});

describe("statusline — formatRspTickerValue", () => {
  it("keeps raw tokens below one thousand", () => {
    expect(formatRspTickerValue(847)).toBe("847");
    expect(formatRspTickerValue(999)).toBe("999");
  });

  it("renders the k tier with one decimal through the 999.9k edge", () => {
    expect(formatRspTickerValue(1000)).toBe("1.0k");
    expect(formatRspTickerValue(12400)).toBe("12.4k");
    expect(formatRspTickerValue(876300)).toBe("876.3k");
    expect(formatRspTickerValue(999949)).toBe("999.9k");
    expect(formatRspTickerValue(999999)).toBe("999.9k");
  });

  it("renders the M tier with three significant digits", () => {
    expect(formatRspTickerValue(1320000)).toBe("1.32M");
    expect(formatRspTickerValue(13200000)).toBe("13.2M");
    expect(formatRspTickerValue(132000000)).toBe("132M");
  });
});

describe("statusline — shortModel (issue #1175)", () => {
  it("shortens a full model id without discarding its version", () => {
    expect(shortModel("claude-opus-4-8")).toBe("opus-4.8");
    expect(shortModel("Opus")).toBe("opus");
    expect(shortModel("claude-sonnet-5")).toBe("sonnet-5");
    expect(shortModel("claude-haiku-4-5-20251001")).toBe("haiku-4.5");
  });

  it("falls back to the input unchanged when no family matches", () => {
    expect(shortModel("gpt-5")).toBe("gpt-5");
  });
});

describe("statusline — project block", () => {
  it("renders the bare basename with no git ref", () => {
    expect(renderProjectBlock({ basename: "c1" })).toBe("c1");
  });

  it("appends the branch in parentheses", () => {
    expect(renderProjectBlock({ basename: "red-skills", branch: "main" })).toBe(
      "red-skills (main)",
    );
  });

  it("marks the session version when a newer cached bundle is available", () => {
    expect(renderProjectBlock({
      basename: "red-skills",
      branch: "main",
      version: "1.2.3",
      latestCachedVersion: "1.2.4",
    })).toBe("red-skills (main) v1.2.3*");
  });

  it("does not mark the session version for older cached bundles", () => {
    expect(renderProjectBlock({
      basename: "red-skills",
      branch: "main",
      version: "1.2.3",
      latestCachedVersion: "1.2.2",
    })).toBe("red-skills (main)");
  });

  it("truncates a long branch to 27 chars plus an ellipsis", () => {
    const long = "afk/wFABQ/9-some-very-long-branch-name";
    const out = renderProjectBlock({ basename: "red-skills", branch: long });
    expect(out).toBe(`red-skills (${long.slice(0, 27)}…)`);
    // 27 kept chars + ellipsis inside the parens.
    expect(out).toContain(`(${long.slice(0, 27)}…)`);
  });

  it("does not truncate a branch of exactly 28 chars", () => {
    const branch = "a".repeat(28);
    expect(renderProjectBlock({ basename: "p", branch })).toBe(`p (${branch})`);
  });

  it("renders the detached sha when there is no branch", () => {
    expect(renderProjectBlock({ basename: "p", detachedSha: "abc1234" })).toBe(
      "p (detached abc1234)",
    );
  });
});

describe("statusline — model block", () => {
  it("renders model·effort when both are present", () => {
    expect(renderModelBlock({ model: "Opus", effort: "high" })).toBe("Opus·high");
  });

  it("renders the bare model when there is no effort", () => {
    expect(renderModelBlock({ model: "Opus" })).toBe("Opus");
  });

  it("drops the block when there is no model (outside Claude Code)", () => {
    expect(renderModelBlock(undefined)).toBeNull();
    expect(renderModelBlock({})).toBeNull();
  });
});

describe("statusline — context block", () => {
  it("renders humanized tokens plus a rounded percent", () => {
    expect(renderContextBlock({ contextTokens: 47000, contextPercent: 24 })).toBe(
      "47k 24%",
    );
  });

  it("rounds the percent to the nearest integer like printf %.0f", () => {
    expect(
      renderContextBlock({ contextTokens: 47000, contextPercent: 23.7 }),
    ).toBe("47k 24%");
  });

  it("renders tokens alone when there is no percent", () => {
    expect(renderContextBlock({ contextTokens: 512 })).toBe("512");
  });

  it("drops the block when tokens are zero or absent", () => {
    expect(renderContextBlock({ contextTokens: 0 })).toBeNull();
    expect(renderContextBlock({})).toBeNull();
    expect(renderContextBlock(undefined)).toBeNull();
  });
});

describe("statusline — usage block", () => {
  it("renders both rate-limit windows as rounded percents", () => {
    expect(renderUsageBlock({ usage5h: 23, usage7d: 41 })).toBe("5h=23% 7d=41%");
  });

  it("rounds each window like printf %.0f", () => {
    expect(renderUsageBlock({ usage5h: 22.6, usage7d: 40.2 })).toBe("5h=23% 7d=40%");
  });

  it("renders only the window that is present (graceful absence)", () => {
    expect(renderUsageBlock({ usage5h: 23 })).toBe("5h=23%");
    expect(renderUsageBlock({ usage7d: 41 })).toBe("7d=41%");
  });

  it("renders a zero percent (0 is present, not absent)", () => {
    expect(renderUsageBlock({ usage5h: 0, usage7d: 0 })).toBe("5h=0% 7d=0%");
  });

  it("drops the block entirely for a non-Pro/Max session (neither window)", () => {
    expect(renderUsageBlock({})).toBeNull();
    expect(renderUsageBlock(undefined)).toBeNull();
    expect(renderUsageBlock({ model: "Opus", contextTokens: 47000 })).toBeNull();
  });
});

describe("statusline — repo block", () => {
  it("renders prs/iss counts and the local diff", () => {
    expect(
      renderRepoBlock({ openPrs: 3, openIssues: 24, localAdded: 142, localRemoved: 36 }),
    ).toBe("prs=3 iss=24 loc=+142 -36");
  });

  it("renders cpr= for pull requests created today alongside prs= and iss=", () => {
    expect(
      renderRepoBlock({ openPrs: 3, todayPrs: 2, openIssues: 24, localAdded: 142, localRemoved: 36 }),
    ).toBe("prs=3 cpr=2 iss=24 loc=+142 -36");
  });

  it("renders cpr= alone when openPrs is 0", () => {
    expect(renderRepoBlock({ openPrs: 0, todayPrs: 5, openIssues: 10 })).toBe("cpr=5 iss=10");
  });

  it("drops cpr= when todayPrs is 0", () => {
    expect(renderRepoBlock({ openPrs: 3, todayPrs: 0, openIssues: 24 })).toBe("prs=3 iss=24");
  });

  it("drops each zero-valued count and a clean branch", () => {
    expect(
      renderRepoBlock({ openPrs: 0, openIssues: 0, localAdded: 0, localRemoved: 0 }),
    ).toBeNull();
    expect(renderRepoBlock(undefined)).toBeNull();
  });

  it("renders only the present sides of the local diff", () => {
    expect(renderRepoBlock({ localAdded: 5 })).toBe("loc=+5");
    expect(renderRepoBlock({ localRemoved: 2 })).toBe("loc=-2");
  });

  it("carries a compact age suffix on prs= when the cache is stale", () => {
    expect(
      renderRepoBlock({ openPrs: 3, openIssues: 24, cacheAgeS: 720 }),
    ).toBe("prs=3 (12m) iss=24");
  });

  it("carries age suffix on prs= even when cpr= is present", () => {
    expect(
      renderRepoBlock({ openPrs: 3, todayPrs: 2, openIssues: 24, cacheAgeS: 720 }),
    ).toBe("prs=3 (12m) cpr=2 iss=24");
  });

  it("moves the age suffix to cpr= when openPrs is 0 but todayPrs > 0", () => {
    expect(
      renderRepoBlock({ openPrs: 0, todayPrs: 2, openIssues: 24, cacheAgeS: 720 }),
    ).toBe("cpr=2 (12m) iss=24");
  });

  it("moves the age suffix to iss= when openPrs is 0 and todayPrs is 0", () => {
    expect(renderRepoBlock({ openPrs: 0, openIssues: 24, cacheAgeS: 720 })).toBe("iss=24 (12m)");
  });
});

describe("statusline — fleet block", () => {
  it("renders runner, busy/total occupancy, queue depth, and parked slots", () => {
    expect(renderFleetBlock({ runner: "codex", busy: 1, total: 2, queue: 7, parked: 1 })).toBe(
      "flt=codex 1/2 q=7 prk=1",
    );
  });

  it("marks a fleet degraded when local worker liveness does not corroborate busy slots", () => {
    expect(renderFleetBlock({ runner: "codex", busy: 2, total: 2, queue: 7, degraded: true })).toBe(
      "flt=codex 2/2† q=7",
    );
  });

  it("shows churn only when recent deaths or respawns are present", () => {
    expect(
      renderFleetBlock({
        runner: "codex",
        busy: 2,
        total: 2,
        queue: 7,
        churnDeaths: 2,
        churnRespawns: 2,
        churnWindowS: 300,
      }),
    ).toBe("flt=codex 2/2 q=7 churn=2d/2r/300s");
    expect(renderFleetBlock({ runner: "codex", busy: 2, total: 2, queue: 7 })).toBe(
      "flt=codex 2/2 q=7",
    );
  });

  it("omits the parked part when fleet.parked is zero", () => {
    expect(renderFleetBlock({ runner: "codex", busy: 0, total: 3, queue: 0 })).toBe(
      "flt=codex 0/3 q=0",
    );
  });
});

describe("statusline — unlanded docs block", () => {
  it("renders only when the count is non-zero", () => {
    expect(renderUnlandedDocsBlock({ count: 3 })).toBe("doc=3");
    expect(renderUnlandedDocsBlock({ count: 0 })).toBeNull();
    expect(renderUnlandedDocsBlock(undefined)).toBeNull();
  });
});

describe("statusline — AFK block", () => {
  it("renders the full token run in the fixed order", () => {
    // case 3: one live worker on #17 with ad12 rm3, blocked 2, cached rq11 rh3.
    expect(renderAfkBlock(baseAfk())).toBe("wrk=1 rdy=11 hmn=3 blk=2 loc=+12 -3 #17");
  });

  it("surfaces the cached quarantine count beside the queue state", () => {
    expect(renderAfkBlock(baseAfk({ quarantine: 4 }))).toBe(
      "wrk=1 rdy=11 hmn=3 qtn=4 blk=2 loc=+12 -3 #17",
    );
  });

  it("sums diffstats and lists both issues for two workers", () => {
    // case 4: wk2, ad42 rm10, bk5, both #17 and #20.
    const out = renderAfkBlock(
      baseAfk({ workers: 2, added: 42, removed: 10, blocked: 5, issues: [17, 20] }),
    );
    expect(out).toContain("wrk=2");
    expect(out).toContain("loc=+42 -10");
    expect(out).toContain("#17");
    expect(out).toContain("#20");
    expect(out).toContain("blk=5");
  });

  it("drops the block when there are no live workers", () => {
    // case 1 / case 2: empty .red/tmp => no wk block.
    expect(renderAfkBlock({ ...baseAfk(), workers: 0 })).toBeNull();
    expect(renderAfkBlock(undefined)).toBeNull();
  });

  it("drops each zero-valued count but keeps the issues", () => {
    const out = renderAfkBlock(
      baseAfk({ queue: 0, human: 0, blocked: 0, added: 5, removed: 2, issues: [17] }),
    );
    expect(out).toBe("wrk=1 loc=+5 -2 #17");
    expect(out).not.toContain("rdy");
    expect(out).not.toContain("hmn");
    expect(out).not.toContain("blk");
  });

  it("renders only the worker count when everything else is zero and no issues", () => {
    expect(
      renderAfkBlock({
        workers: 1,
        queue: 0,
        human: 0,
        blocked: 0,
        added: 0,
        removed: 0,
        issues: [],
      }),
    ).toBe("wrk=1");
  });

  it("suffixes each issue with its stage when present, aligned by index", () => {
    const out = renderAfkBlock(
      baseAfk({ workers: 2, issues: [17, 20], phases: ["impl", "tests"] }),
    );
    expect(out).toContain("#17·impl");
    expect(out).toContain("#20·tests");
  });

  it("falls back to a bare #N when the stage is empty or the arrays misalign", () => {
    const out = renderAfkBlock(
      baseAfk({ workers: 2, issues: [17, 20], phases: ["impl"] }),
    );
    expect(out).toContain("#17·impl");
    expect(out).toContain("#20");
    expect(out).not.toContain("#20·");
  });

  it("renders wtN after the diff only when waiting > 0", () => {
    expect(renderAfkBlock(baseAfk({ waiting: 4 }))).toBe(
      "wrk=1 rdy=11 hmn=3 blk=2 loc=+12 -3 wai=4 #17",
    );
    expect(renderAfkBlock(baseAfk({ waiting: 0 }))).not.toContain("wai");
    expect(renderAfkBlock(baseAfk())).not.toContain("wai");
  });

  it("renders tk humanized tokens and $ cost after wt, each only when > 0", () => {
    expect(renderAfkBlock(baseAfk({ tokens: 12500, costUsd: 0.42 }))).toBe(
      "wrk=1 rdy=11 hmn=3 blk=2 loc=+12 -3 tok=12k usd=0.42 #17",
    );
    // tokens but no cost (the common case — most runners report tokens, not USD)
    expect(renderAfkBlock(baseAfk({ tokens: 900 }))).toContain("tok=900");
    expect(renderAfkBlock(baseAfk({ tokens: 900 }))).not.toContain("usd");
    // neither when zero/absent
    expect(renderAfkBlock(baseAfk({ tokens: 0, costUsd: 0 }))).not.toMatch(/tok=|usd=/);
    expect(renderAfkBlock(baseAfk())).not.toMatch(/tok=|usd=/);
  });

  it("appends alive time after stage when both are present", () => {
    const out = renderAfkBlock(
      baseAfk({ issues: [17], phases: ["impl"], aliveMs: [5 * 60 * 1000] }),
    );
    expect(out).toContain("#17·impl·5m");
  });

  it("appends alive time without stage when stage is absent but aliveMs is set", () => {
    const out = renderAfkBlock(
      baseAfk({ issues: [17], aliveMs: [(1 * 60 * 60 + 22 * 60) * 1000] }),
    );
    expect(out).toContain("#17·1h22m");
  });

  it("appends alive time per-issue aligned by index", () => {
    const out = renderAfkBlock(
      baseAfk({
        workers: 2,
        issues: [17, 20],
        phases: ["impl", "tests"],
        aliveMs: [5 * 60 * 1000, 30 * 1000],
      }),
    );
    expect(out).toContain("#17·impl·5m");
    expect(out).toContain("#20·tests·30s");
  });

  it("renders loc= with a ~ prefix when locIsPeak is true", () => {
    expect(renderAfkBlock(baseAfk({ locIsPeak: true }))).toBe(
      "wrk=1 rdy=11 hmn=3 blk=2 loc=~+12 -3 #17",
    );
  });

  it("renders normal loc= when locIsPeak is false or absent", () => {
    expect(renderAfkBlock(baseAfk())).toBe("wrk=1 rdy=11 hmn=3 blk=2 loc=+12 -3 #17");
    expect(renderAfkBlock(baseAfk({ locIsPeak: false }))).toBe("wrk=1 rdy=11 hmn=3 blk=2 loc=+12 -3 #17");
  });

  it("keeps the pre-vitals render byte-for-byte when no waiting/stages/aliveMs are supplied", () => {
    // All new fields are optional: an aggregator that never populates them must
    // produce the exact legacy line, so the upgrade is a no-op for old callers.
    expect(renderAfkBlock(baseAfk())).toBe("wrk=1 rdy=11 hmn=3 blk=2 loc=+12 -3 #17");
  });

  it("fresh cache (no cacheAgeS) renders plain with no age marker", () => {
    // cacheAgeS absent → no age annotation on rdy= or hmn=
    expect(renderAfkBlock(baseAfk())).not.toContain("(");
  });

  it("rdy= carries a compact age suffix when cacheAgeS is set (stale cache)", () => {
    // 720 s = 12 min stale → (12m) on the rdy= token
    expect(renderAfkBlock(baseAfk({ cacheAgeS: 720 }))).toBe(
      "wrk=1 rdy=11 (12m) hmn=3 blk=2 loc=+12 -3 #17",
    );
  });

  it("age suffix moves to hmn= when queue is 0 but human is live", () => {
    expect(renderAfkBlock(baseAfk({ queue: 0, human: 3, cacheAgeS: 720 }))).toBe(
      "wrk=1 hmn=3 (12m) blk=2 loc=+12 -3 #17",
    );
  });

  it("no age suffix when both queue and human are 0 even if cacheAgeS is set", () => {
    // 0/0 stale vs 0/0 fresh is indistinguishable in meaning; nothing to annotate
    const out = renderAfkBlock(baseAfk({ queue: 0, human: 0, cacheAgeS: 720 }));
    expect(out).not.toContain("(");
  });
});

describe("statusline — full assembly", () => {
  it("joins every present block with ` · ` in the documented shape", () => {
    const input: StatuslineInput = {
      project: { basename: "red-skills", branch: "main" },
      claude: { model: "Opus", effort: "high", contextTokens: 47000, contextPercent: 24 },
      afk: { workers: 4, queue: 1, human: 11, blocked: 10, added: 12, removed: 3, issues: [17] },
    };
    expect(renderStatusline(input)).toBe(
      "red-skills (main) · Opus·high · 47k 24% · wrk=4 rdy=1 hmn=11 blk=10 loc=+12 -3 #17",
    );
  });

  it("wires usage and repo blocks into the single aggregate line (Codex/plain form)", () => {
    const input: StatuslineInput = {
      project: { basename: "red-skills", branch: "main" },
      claude: { model: "Opus", effort: "high", contextTokens: 47000, contextPercent: 24, usage5h: 23, usage7d: 41 },
      repo: { openPrs: 3, openIssues: 24, localAdded: 142, localRemoved: 36 },
      docs: { count: 2 },
      afk: { workers: 4, queue: 1, human: 11, blocked: 10, added: 12, removed: 3, issues: [17] },
    };
    expect(renderStatusline(input)).toBe(
      "red-skills (main) · Opus·high · 47k 24% · 5h=23% 7d=41% · prs=3 iss=24 loc=+142 -36 · doc=2 · wrk=4 rdy=1 hmn=11 blk=10 loc=+12 -3 #17",
    );
    expect(renderStatuslineWithPreset(input, "full")).toBe(renderStatusline(input));
  });

  it("short preset keeps only project identity, ctx, and iss in the Codex/plain form", () => {
    const input: StatuslineInput = {
      project: { basename: "red-skills", branch: "main" },
      claude: { model: "Opus", effort: "high", contextTokens: 47000, contextPercent: 24, usage5h: 23, usage7d: 41 },
      repo: { openPrs: 3, openIssues: 24, localAdded: 142, localRemoved: 36 },
      rsp: { state: "ready", tokensSavedToday: 1200 },
      fleet: { runner: "codex", busy: 1, total: 4, queue: 9 },
      afk: { workers: 4, queue: 1, human: 11, blocked: 10, added: 12, removed: 3, issues: [17] },
    };
    expect(renderStatuslineWithPreset(input, "short")).toBe("red-skills (main) · ctx=47k 24% · iss=24 · rsp=↓1.2k");
  });

  it("renders rsp healthy token savings without the dollar segment in full and short presets", () => {
    const input: StatuslineInput = {
      project: { basename: "red-skills", branch: "main" },
      rsp: { state: "ready", tokensSavedToday: 847 },
    };
    expect(renderStatusline(input)).toBe("red-skills (main) · rsp=↓847");
    expect(renderStatuslineWithPreset(input, "short")).toBe("red-skills (main) · rsp=↓847");
    expect(renderStatusline({
      project: { basename: "red-skills", branch: "main" },
      rsp: { state: "ready", tokensSavedToday: 2000, dollarsSavedTodayUsd: 0.0025 },
    })).toBe("red-skills (main) · rsp=↓2.0k");
  });

  it("omits the decisions suffix regardless of cached lane data", () => {
    const input: StatuslineInput = {
      project: { basename: "red-skills", branch: "main" },
      rsp: {
        state: "ready",
        tokensSavedToday: 1200,
        decisions: { contributed: 8, seen: 10 },
      },
    };
    expect(renderStatusline(input)).toBe("red-skills (main) · rsp=↓1.2k");
    expect(renderStatuslineWithPreset(input, "short")).toBe("red-skills (main) · rsp=↓1.2k");
  });

  it("omits rsp decisions contribution when the cached decisions lane is missing", () => {
    expect(renderStatusline({
      project: { basename: "red-skills", branch: "main" },
      rsp: { state: "ready", tokensSavedToday: 1200 },
    })).toBe("red-skills (main) · rsp=↓1.2k");
    expect(renderStatusline({
      project: { basename: "red-skills", branch: "main" },
      rsp: {
        state: "ready",
        tokensSavedToday: 1200,
        decisions: { contributed: 0, seen: 0 },
      },
    })).toBe("red-skills (main) · rsp=↓1.2k");
  });

  it("renders rsp warming and error states without ambiguous on/off glyphs", () => {
    expect(renderStatusline({
      project: { basename: "red-skills", branch: "main" },
      rsp: { state: "warming" },
    })).toBe("red-skills (main) · rsp=…");
    expect(renderStatusline({
      project: { basename: "red-skills", branch: "main" },
      rsp: { state: "error" },
    })).toBe("red-skills (main) · rsp=!");
  });

  it("formats rsp savings with compact count tiers", () => {
    const rendered = [0, 847, 1200, 124000, 1320000].map((tokensSavedToday) =>
      renderStatusline({ project: { basename: "red-skills" }, rsp: { state: "ready", tokensSavedToday } })
    );
    expect(rendered).toEqual([
      "red-skills · rsp=↓0",
      "red-skills · rsp=↓847",
      "red-skills · rsp=↓1.2k",
      "red-skills · rsp=↓124.0k",
      "red-skills · rsp=↓1.32M",
    ]);
  });

  it("omits rsp when the gather side leaves the status absent", () => {
    expect(renderStatusline({ project: { basename: "red-skills" } })).toBe("red-skills");
  });

  it("keeps the pre-#1165 line byte-for-byte when repo and usage are absent", () => {
    const input: StatuslineInput = {
      project: { basename: "red-skills", branch: "main" },
      claude: { model: "Opus", effort: "high", contextTokens: 47000, contextPercent: 24 },
      afk: { workers: 4, queue: 1, human: 11, blocked: 10, added: 12, removed: 3, issues: [17] },
    };
    expect(renderStatusline(input)).toBe(
      "red-skills (main) · Opus·high · 47k 24% · wrk=4 rdy=1 hmn=11 blk=10 loc=+12 -3 #17",
    );
  });

  it("renders the header stats even with no live workers (repo line always shows)", () => {
    const out = renderStatusline({
      project: { basename: "red-skills", branch: "main" },
      claude: { model: "Opus", effort: "high", contextTokens: 47000, contextPercent: 24, usage5h: 5 },
      repo: { openPrs: 2, openIssues: 9 },
    });
    expect(out).toBe("red-skills (main) · Opus·high · 47k 24% · 5h=5% · prs=2 iss=9");
    expect(out).not.toContain("wrk");
  });

  it("drops the model and context blocks outside Claude Code", () => {
    const out = renderStatusline({
      project: { basename: "c3" },
      afk: baseAfk(),
    });
    expect(out).toBe("c3 · wrk=1 rdy=11 hmn=3 blk=2 loc=+12 -3 #17");
    expect(out).not.toContain("Opus");
    expect(out).not.toContain("%");
  });

  it("drops the AFK block when there are no .red/tmp workers but keeps the project name", () => {
    const out = renderStatusline({
      project: { basename: "c1" },
      claude: { model: "Opus", effort: "high", contextTokens: 47000, contextPercent: 24 },
    });
    expect(out).toBe("c1 · Opus·high · 47k 24%");
    expect(out).not.toContain("wrk");
    expect(out).toContain("c1");
  });

  it("renders the project name alone when nothing else is present", () => {
    expect(renderStatusline({ project: { basename: "bare" } })).toBe("bare");
  });
});
