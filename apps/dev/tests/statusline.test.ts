import { describe, expect, it } from "vitest";
import {
  humanizeTokens,
  renderAfkBlock,
  renderContextBlock,
  renderModelBlock,
  renderProjectBlock,
  renderStatusline,
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

describe("statusline — project block", () => {
  it("renders the bare basename with no git ref", () => {
    expect(renderProjectBlock({ basename: "c1" })).toBe("c1");
  });

  it("appends the branch in parentheses", () => {
    expect(renderProjectBlock({ basename: "red-skills", branch: "main" })).toBe(
      "red-skills (main)",
    );
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

describe("statusline — AFK block", () => {
  it("renders the full token run in the fixed order", () => {
    // case 3: one live worker on #17 with ad12 rm3, blocked 2, cached rq11 rh3.
    expect(renderAfkBlock(baseAfk())).toBe("wk1 rq11 rh3 bk2 ad12 rm3 #17");
  });

  it("sums diffstats and lists both issues for two workers", () => {
    // case 4: wk2, ad42 rm10, bk5, both #17 and #20.
    const out = renderAfkBlock(
      baseAfk({ workers: 2, added: 42, removed: 10, blocked: 5, issues: [17, 20] }),
    );
    expect(out).toContain("wk2");
    expect(out).toContain("ad42 rm10");
    expect(out).toContain("#17");
    expect(out).toContain("#20");
    expect(out).toContain("bk5");
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
    expect(out).toBe("wk1 ad5 rm2 #17");
    expect(out).not.toContain("rq");
    expect(out).not.toContain("rh");
    expect(out).not.toContain("bk");
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
    ).toBe("wk1");
  });

  it("suffixes each issue with its stage when present, aligned by index", () => {
    const out = renderAfkBlock(
      baseAfk({ workers: 2, issues: [17, 20], stages: ["impl", "tests"] }),
    );
    expect(out).toContain("#17·impl");
    expect(out).toContain("#20·tests");
  });

  it("falls back to a bare #N when the stage is empty or the arrays misalign", () => {
    const out = renderAfkBlock(
      baseAfk({ workers: 2, issues: [17, 20], stages: ["impl"] }),
    );
    expect(out).toContain("#17·impl");
    expect(out).toContain("#20");
    expect(out).not.toContain("#20·");
  });

  it("renders wtN after the diff only when waiting > 0", () => {
    expect(renderAfkBlock(baseAfk({ waiting: 4 }))).toBe("wk1 rq11 rh3 bk2 ad12 rm3 wt4 #17");
    expect(renderAfkBlock(baseAfk({ waiting: 0 }))).not.toContain("wt");
    expect(renderAfkBlock(baseAfk())).not.toContain("wt");
  });

  it("renders tk humanized tokens and $ cost after wt, each only when > 0", () => {
    expect(renderAfkBlock(baseAfk({ tokens: 12500, costUsd: 0.42 }))).toBe(
      "wk1 rq11 rh3 bk2 ad12 rm3 tk12k $0.42 #17",
    );
    // tokens but no cost (the common case — most runners report tokens, not USD)
    expect(renderAfkBlock(baseAfk({ tokens: 900 }))).toContain("tk900");
    expect(renderAfkBlock(baseAfk({ tokens: 900 }))).not.toContain("$");
    // neither when zero/absent
    expect(renderAfkBlock(baseAfk({ tokens: 0, costUsd: 0 }))).not.toMatch(/tk|\$/);
    expect(renderAfkBlock(baseAfk())).not.toMatch(/tk|\$/);
  });

  it("keeps the pre-vitals render byte-for-byte when no waiting/stages are supplied", () => {
    // The new fields are optional: an aggregator that never populates them must
    // produce the exact legacy line, so the upgrade is a no-op for old callers.
    expect(renderAfkBlock(baseAfk())).toBe("wk1 rq11 rh3 bk2 ad12 rm3 #17");
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
      "red-skills (main) · Opus·high · 47k 24% · wk4 rq1 rh11 bk10 ad12 rm3 #17",
    );
  });

  it("drops the model and context blocks outside Claude Code", () => {
    const out = renderStatusline({
      project: { basename: "c3" },
      afk: baseAfk(),
    });
    expect(out).toBe("c3 · wk1 rq11 rh3 bk2 ad12 rm3 #17");
    expect(out).not.toContain("Opus");
    expect(out).not.toContain("%");
  });

  it("drops the AFK block when there are no .red/tmp workers but keeps the project name", () => {
    const out = renderStatusline({
      project: { basename: "c1" },
      claude: { model: "Opus", effort: "high", contextTokens: 47000, contextPercent: 24 },
    });
    expect(out).toBe("c1 · Opus·high · 47k 24%");
    expect(out).not.toContain("wk");
    expect(out).toContain("c1");
  });

  it("renders the project name alone when nothing else is present", () => {
    expect(renderStatusline({ project: { basename: "bare" } })).toBe("bare");
  });
});
