import { describe, expect, it } from "vitest";
import { renderStatusline, type AfkInput, type StatuslineInput } from "../src/core/statusline.js";
import {
  renderAfkLine,
  renderHeaderLine,
  renderStatuslineThemed,
  styleStatusline,
} from "../src/core/statusline-style.js";

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
// eslint-disable-next-line no-control-regex
const vlen = (s: string): number => stripAnsi(s).length;

const WINE = "\x1b[48;2;114;47;55m";
const WINE2 = "\x1b[48;2;88;36;42m";
const BLACK = "\x1b[48;2;0;0;0m";
const RESET = "\x1b[0m";

const afk: AfkInput = { workers: 1, queue: 11, human: 3, blocked: 2, added: 12, removed: 3, issues: [17] };
const input: StatuslineInput = {
  project: { basename: "red-skills", branch: "main" },
  claude: { model: "Opus", effort: "high", contextTokens: 47000, contextPercent: 24 },
  afk,
};

describe("statusline style — header line", () => {
  it("is one powerline row: » bold project, model·effort, ctx — ending in a reset", () => {
    const h = renderHeaderLine(input.project, input.claude);
    expect(h).not.toContain("\n");
    expect(h.endsWith(RESET)).toBe(true);
    expect(h).toContain(WINE2); // project + ctx blocks
    expect(h).toContain(WINE); // model block
    expect(stripAnsi(h)).toContain("» red-skills (main)");
    expect(stripAnsi(h)).toContain("Opus·high");
    expect(stripAnsi(h)).toContain("ctx47k 24%");
  });

  it("drops the model and ctx blocks outside Claude Code", () => {
    const h = renderHeaderLine({ basename: "c3" }, undefined);
    expect(stripAnsi(h)).toBe(" » c3 ");
    expect(h).not.toContain(WINE); // only the WINE2 project block remains
  });
});

describe("statusline style — AFK line", () => {
  it("chips each KPI number and splits backlog (WINE2) from active (WINE)", () => {
    const line = renderAfkLine(afk, undefined);
    expect(line).not.toBeNull();
    expect(line!.endsWith(RESET)).toBe(true);
    expect(line).toContain(BLACK); // numbers are drawn as black chips
    expect(line).toContain(WINE2); // backlog block
    expect(line).toContain(WINE); // active block
    expect(stripAnsi(line!)).toContain("rq11 rh3 bk2");
    expect(stripAnsi(line!)).toContain("wk1 ad12 rm3 #17");
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
    expect(stripAnsi(wide!)).not.toContain("+"); // all six fit in 200 cols
    const narrow = renderAfkLine({ ...afk, workers: 6, issues: [1, 2, 3, 4, 5, 6] }, 40);
    const ntxt = stripAnsi(narrow!);
    expect(vlen(narrow!)).toBeLessThanOrEqual(40);
    expect(ntxt).toMatch(/\+\d/); // overflow marker present
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
    expect(stripAnsi(rows[1])).toContain("wk1");
  });

  it("emits only the header row when there are no live workers", () => {
    const out = styleStatusline({ project: input.project, claude: input.claude });
    expect(out).not.toContain("\n");
    expect(stripAnsi(out)).toContain("Opus·high");
  });

  it("renderStatuslineThemed switches between powerline and plain on the color flag", () => {
    expect(renderStatuslineThemed(input, true)).toBe(styleStatusline(input));
    expect(renderStatuslineThemed(input, false)).toBe(renderStatusline(input));
    expect(renderStatuslineThemed(input, false)).not.toContain("\x1b");
  });
});
