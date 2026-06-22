import { describe, expect, it } from "vitest";
import { renderStatusline, type AfkInput, type StatuslineInput } from "../src/core/statusline.js";
import {
  renderStatuslineThemed,
  styleAfkBlock,
  styleStatusline,
} from "../src/core/statusline-style.js";

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const WINE_BG = "\x1b[48;2;114;47;55m";
const BLACK_BG = "\x1b[48;2;0;0;0m";
const WHITE_FG = "\x1b[38;2;255;255;255m";
const RESET = "\x1b[0m";

const afk: AfkInput = { workers: 4, queue: 1, human: 11, blocked: 10, added: 12, removed: 3, issues: [17] };
const input: StatuslineInput = {
  project: { basename: "red-skills", branch: "main" },
  claude: { model: "Opus", effort: "high", contextTokens: 47000, contextPercent: 24 },
  afk,
};

describe("statusline style — AFK chips", () => {
  it("chips every KPI value in black and leaves the label on the wine field", () => {
    const block = styleAfkBlock(input.afk);
    // The worker label sits outside the chip; its value is wrapped black→wine.
    expect(block).toContain(`wk${BLACK_BG}4${WINE_BG}`);
    expect(block).toContain(`ad${BLACK_BG}12${WINE_BG}`);
    expect(block).toContain(`#${BLACK_BG}17${WINE_BG}`);
    // Stripped, the styled block equals the plain initials run.
    expect(stripAnsi(block)).toBe("wk4 rq1 rh11 bk10 ad12 rm3 #17");
  });

  it("chips only the numeric value of an issue, leaving its ·stage on the field", () => {
    const block = styleAfkBlock({
      workers: 1,
      queue: 0,
      human: 0,
      blocked: 0,
      added: 0,
      removed: 0,
      issues: [17],
      stages: ["impl"],
    });
    expect(block).toContain(`#${BLACK_BG}17${WINE_BG}·impl`);
  });

  it("is empty when there are no live workers", () => {
    expect(styleAfkBlock(undefined)).toBe("");
    expect(styleAfkBlock({ ...afk, workers: 0 })).toBe("");
  });
});

describe("statusline style — full themed line", () => {
  it("wraps the whole line in wine + white and resets at the end", () => {
    const line = styleStatusline(input);
    expect(line.startsWith(`${WINE_BG}${WHITE_FG}`)).toBe(true);
    expect(line.endsWith(RESET)).toBe(true);
  });

  it("changes only appearance — stripped, it equals the plain render exactly", () => {
    expect(stripAnsi(styleStatusline(input))).toBe(renderStatusline(input));
  });

  it("renderStatuslineThemed switches between styled and plain on the color flag", () => {
    expect(renderStatuslineThemed(input, true)).toBe(styleStatusline(input));
    expect(renderStatuslineThemed(input, false)).toBe(renderStatusline(input));
    // The plain path carries no escape sequences at all.
    expect(renderStatuslineThemed(input, false)).not.toContain("\x1b");
  });
});
