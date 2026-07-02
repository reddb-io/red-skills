import { describe, expect, it } from "vitest";
import {
  renderStatusline,
  type AfkInput,
  type RepoInput,
  type StatuslineInput,
} from "../src/core/statusline.js";
import {
  renderAfkLine,
  renderHeaderLine,
  renderStatuslineThemed,
  styleStatusline,
} from "../src/core/statusline-style.js";

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const vlen = (s: string): number => stripAnsi(s).length;

const WINE = "\x1b[48;2;114;47;55m";
const WINE2 = "\x1b[48;2;88;36;42m";
const NOBG = "\x1b[49m";
const SOFT = "\x1b[38;2;224;138;148m";
const RESET = "\x1b[0m";

const afk: AfkInput = { workers: 1, queue: 11, human: 3, blocked: 2, added: 12, removed: 3, issues: [17] };
const repo: RepoInput = { openPrs: 3, openIssues: 24, localAdded: 142, localRemoved: 36 };
const input: StatuslineInput = {
  project: { basename: "red-skills", branch: "main", version: "1.2.3" },
  claude: { model: "Opus", effort: "high", contextTokens: 47000, contextPercent: 24 },
  repo,
  afk,
};

describe("statusline style — header line", () => {
  it("powerlines » project, model·effort, ctx, pr/is, +local/-local — reset-terminated", () => {
    const h = renderHeaderLine(input.project, input.claude, repo);
    expect(h).not.toContain("\n");
    expect(h.endsWith(RESET)).toBe(true);
    expect(h).toContain(WINE2); // project block bg
    expect(h).toContain(WINE); // model block bg
    expect(h).toContain(NOBG); // background drops to transparent after the model
    const t = stripAnsi(h);
    expect(t).toContain("» red-skills (main)");
    expect(t).toContain("v1.2.3"); // fixed fixture version — proves the renderer echoes whatever version it is handed (not the live build version)
    expect(t).toContain("Opus·high");
    expect(t).toContain("ctx=47k 24%");
    expect(t).toContain("prs=3");
    expect(t).toContain("iss=24");
    expect(t).toContain("loc=+142 -36");
  });

  it("drops the repo blocks when counts are zero / a clean branch", () => {
    const h = renderHeaderLine(input.project, input.claude, {
      openPrs: 0,
      openIssues: 0,
      localAdded: 0,
      localRemoved: 0,
    });
    const t = stripAnsi(h);
    expect(t).not.toContain("prs=");
    expect(t).not.toContain("iss=");
    expect(t).not.toContain("loc=");
  });

  it("drops model/ctx/repo outside Claude Code with no repo stats", () => {
    const h = renderHeaderLine({ basename: "c3" }, undefined, undefined);
    expect(stripAnsi(h)).toBe(" » c3 ");
    expect(h).not.toContain(WINE);
  });
});

describe("statusline style — AFK line", () => {
  it("chips KPI numbers across the runner/workers/transit/pipeline blocks", () => {
    const line = renderAfkLine({ ...afk, runner: "claude", resolved: 7 }, undefined);
    expect(line).not.toBeNull();
    expect(line!.endsWith(RESET)).toBe(true);
    expect(line).toContain(NOBG); // line 2 is fully transparent — no red block
    expect(line).toContain(SOFT); // softer red for the runner / sigils
    expect(line).not.toContain(WINE); // never a wine background on line 2
    const t = stripAnsi(line!);
    expect(t).toContain("claude"); // runner
    expect(t).toContain("wrk=1 res=7"); // workers + resolved
    expect(t).toContain("loc=+12 -3"); // in-transit diff
    expect(t).toContain("rdy=11 hmn=3 blk=2"); // pipeline
    expect(t).toContain("#17");
  });

  it("omits runner and res when absent / zero", () => {
    const t = stripAnsi(renderAfkLine(afk, undefined)!);
    expect(t).not.toContain("res");
    expect(t.startsWith(" wrk=1")).toBe(true); // first group is workers, no runner
  });

  it("renders compact model-effort alongside the runner label", () => {
    const line = renderAfkLine(
      { ...afk, runner: "claude", model: "claude-opus-4-8", effort: "max" },
      undefined,
    );
    const t = stripAnsi(line!);
    expect(t).toContain("claude-opus max");
    expect(t).not.toContain("claude-opus-4-8"); // always compact
  });

  it("renders runner + compact model without effort when effort is absent", () => {
    const t = stripAnsi(renderAfkLine({ ...afk, runner: "codex", model: "gpt-4o" }, undefined)!);
    expect(t).toContain("codex gpt-4o"); // non-claude model: falls back to the full name
  });

  it("renders alive time suffix on issue tokens", () => {
    const line = renderAfkLine(
      { ...afk, issues: [17], stages: ["impl"], aliveMs: [5 * 60 * 1000] },
      undefined,
    );
    expect(stripAnsi(line!)).toContain("#17·impl·5m");
  });

  it("renders loc= with a ~ prefix when locIsPeak is true", () => {
    const t = stripAnsi(renderAfkLine({ ...afk, locIsPeak: true }, undefined)!);
    expect(t).toContain("loc=~+12 -3");
    expect(t).not.toContain("loc=+12 -3"); // ~ prefix replaces the plain form
  });

  it("is null when there are no live workers", () => {
    expect(renderAfkLine(undefined, undefined)).toBeNull();
    expect(renderAfkLine({ ...afk, workers: 0 }, undefined)).toBeNull();
  });

  it("shows the ·stage suffix only at or below two workers", () => {
    const few = renderAfkLine({ ...afk, workers: 2, issues: [17, 20], stages: ["impl", "tests"] }, undefined);
    expect(stripAnsi(few!)).toContain("#17·impl");
    expect(stripAnsi(few!)).toContain("#20·tests");

    const many = renderAfkLine({ ...afk, workers: 5, issues: [17, 20], stages: ["impl", "tests"] }, undefined);
    expect(stripAnsi(many!)).not.toContain("·impl");
    expect(stripAnsi(many!)).toContain("#17");
  });

  it("caps the issue list at 3 with a +N overflow when no COLUMNS budget", () => {
    const line = renderAfkLine({ ...afk, workers: 5, issues: [17, 20, 21, 22, 23] }, undefined);
    const txt = stripAnsi(line!);
    expect(txt).toContain("#17");
    expect(txt).toContain("#21");
    expect(txt).not.toContain("#22");
    expect(txt).toContain("+2");
  });

  it("fits the issue list to the COLUMNS budget, collapsing the rest into +N", () => {
    const wide = renderAfkLine({ ...afk, workers: 6, issues: [1, 2, 3, 4, 5, 6] }, 200);
    expect(stripAnsi(wide!)).toContain("#6"); // all six issues fit in 200 cols (none collapsed)
    // The verbose key=value KPI run is wider than the old 2-letter chips, so the
    // fixed groups alone are ~40 cols for a busy fleet; the budget can only trim
    // ISSUES. 56 is the realistic narrow floor where collapsing is exercised.
    // (We assert collapse via a dropped #N, not a bare "+", since the loc=+A -R
    // diff value also contains a "+".)
    const narrow = renderAfkLine({ ...afk, workers: 6, issues: [1, 2, 3, 4, 5, 6] }, 56);
    expect(vlen(narrow!)).toBeLessThanOrEqual(56);
    expect(stripAnsi(narrow!)).not.toContain("#6"); // tail issues collapsed into +N
    expect(stripAnsi(narrow!)).toMatch(/ \+\d/); // the +N overflow marker is present
  });
});

describe("statusline style — full themed assembly", () => {
  it("emits two rows (header + AFK) when workers are live, each reset-terminated", () => {
    const out = styleStatusline(input);
    const rows = out.split("\n");
    expect(rows).toHaveLength(2);
    expect(rows[0].endsWith(RESET)).toBe(true);
    expect(rows[1].endsWith(RESET)).toBe(true);
    expect(stripAnsi(rows[0])).toContain("» red-skills");
    expect(stripAnsi(rows[0])).toContain("prs=3");
    expect(stripAnsi(rows[1])).toContain("wrk=1");
  });

  it("emits only the header row when there are no live workers", () => {
    const out = styleStatusline({ project: input.project, claude: input.claude, repo });
    expect(out).not.toContain("\n");
    expect(stripAnsi(out)).toContain("Opus·high");
    expect(stripAnsi(out)).toContain("prs=3");
  });

  it("renderStatuslineThemed switches between powerline and plain on the color flag", () => {
    expect(renderStatuslineThemed(input, true)).toBe(styleStatusline(input));
    expect(renderStatuslineThemed(input, false)).toBe(renderStatusline(input));
    expect(renderStatuslineThemed(input, false)).not.toContain("\x1b");
  });
});
