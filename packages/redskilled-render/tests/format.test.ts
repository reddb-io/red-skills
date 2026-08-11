/**
 * format — the layout primitives measure what the terminal draws (#3150).
 *
 * The package was colourless by construction, not by decision: `width()` counted
 * one character as one column, so a `k=v` wearing a truecolour escape measured
 * nineteen columns wider than it drew. Every claim below is that construction
 * refuted — measure visibly, cut between columns, close what was opened.
 */
import { describe, expect, it } from "vitest";
import { clamp, pad, shortModel, stripAnsi, width } from "../format.js";
import { BAR_DONE, IDENTITY_BG, KEY, MODEL_BG, RESET, SOFT, SPOTLIGHT, VAL } from "../palette.js";

const ESC = "\x1b";

describe("width measures visible columns, not stored characters", () => {
  it("counts a coloured k=v as the columns it draws", () => {
    expect(width(`${KEY}iss=3096${RESET}`)).toBe(8);
    expect(width("iss=3096")).toBe(8);
  });

  it("charges nothing for the escapes a fully painted line carries", () => {
    const painted = `${IDENTITY_BG}${KEY}acme${RESET}`;
    expect(width(painted)).toBe(4);
    expect(painted.length).toBeGreaterThan(20);
  });

  it("still counts an uncoloured line by its characters", () => {
    expect(width("")).toBe(0);
    expect(width("acme/widgets 1w")).toBe(15);
  });

  it("counts an astral character once, as before", () => {
    expect(width("▶░░░")).toBe(4);
    expect(width(`${BAR_DONE}▶░░░${RESET}`)).toBe(4);
  });
});

describe("stripAnsi hands a caller the plain string", () => {
  it("removes every SGR escape and nothing else", () => {
    expect(stripAnsi(`${MODEL_BG}${KEY}iss=${VAL}3096${SOFT}${RESET}`)).toBe("iss=3096");
  });

  it("leaves a line that carries no colour untouched", () => {
    expect(stripAnsi("iss=3096")).toBe("iss=3096");
  });
});

describe("clamp cuts between columns and closes what it opened", () => {
  it("spends the budget on visible columns, so a coloured line that fits is untouched", () => {
    const line = `${KEY}iss=3096${RESET}`;
    expect(clamp(line, 8)).toBe(line);
    expect(clamp(line, 80)).toBe(line);
  });

  it("cuts a coloured line at the same column as its plain twin", () => {
    const plain = clamp("iss=3096 phase=coding", 12);
    const coloured = clamp(`${KEY}iss=3096 phase=coding${RESET}`, 12);
    expect(stripAnsi(coloured)).toBe(plain);
    expect(width(coloured)).toBe(12);
  });

  it("never emits a partial escape", () => {
    // The cut lands inside the run of text that FOLLOWS a 19-character escape:
    // a character-counting clamp would slice the escape itself in half.
    const line = `${KEY}iss=3096 phase=coding${RESET}`;
    for (let budget = 1; budget <= width(line) + 2; budget += 1) {
      const cut = clamp(line, budget);
      const orphan = cut.split(ESC).slice(1).find((tail) => !/^\[[0-9;]*m/.test(tail));
      expect(orphan, `budget ${budget} left a partial escape`).toBeUndefined();
    }
  });

  it("closes a colour it opened, so the cut does not paint the rows below", () => {
    const cut = clamp(`${KEY}iss=3096 phase=coding`, 12);
    expect(cut.endsWith(RESET)).toBe(true);
    expect(cut.startsWith(KEY)).toBe(true);
  });

  it("adds no reset when the line already closed itself before the cut", () => {
    // The cut lands in `ghij`, PAST the reset — nothing is left open, so a
    // second reset would be noise on every clamped row.
    expect(clamp(`${KEY}abcdef${RESET}ghij`, 9).endsWith(RESET)).toBe(false);
  });

  it("reads a bare and a zero-padded reset as closed, and a default-fg as still open", () => {
    expect(clamp(`${KEY}abcdef${ESC}[mghij`, 9).endsWith(RESET)).toBe(false);
    expect(clamp(`${KEY}abcdef${ESC}[0;0mghij`, 9).endsWith(RESET)).toBe(false);
    // `39` restores the default FOREGROUND but leaves any background standing,
    // so it is not a close and the cut must still emit one.
    expect(clamp(`${MODEL_BG}abcdef${VAL}ghij`, 9).endsWith(RESET)).toBe(true);
  });

  it("adds no reset to a line that carried no colour", () => {
    expect(clamp("iss=3096 phase=coding", 12)).toBe("iss=3096 ph…");
    expect(clamp("iss=3096", 1)).toBe("…");
    expect(clamp("iss=3096", 0)).toBe("");
  });

  it("keeps the ellipsis at the tightest budget even when the line is painted", () => {
    expect(clamp(`${SPOTLIGHT}iss=3096${RESET}`, 1)).toBe("…");
    expect(clamp(`${SPOTLIGHT}iss=3096${RESET}`, 0)).toBe("");
  });
});

describe("pad aligns a coloured cell to the same column as an uncoloured one", () => {
  it("pads by visible width", () => {
    const coloured = pad(`${KEY}iss=${VAL}3096${SOFT}`, 12);
    const plain = pad("iss=3096", 12);
    expect(width(coloured)).toBe(12);
    expect(width(plain)).toBe(12);
    expect(stripAnsi(coloured)).toBe(plain);
  });

  it("does not shrink a cell already wider than its column", () => {
    expect(pad(`${KEY}iss=3096${RESET}`, 4)).toBe(`${KEY}iss=3096${RESET}`);
  });
});

describe("shortModel lives here now (#3150)", () => {
  it.each([
    ["claude-opus-5", "opus-5"],
    ["claude-opus-4-8", "opus-4.8"],
    ["claude-sonnet-5", "sonnet-5"],
    ["claude-haiku-4-5-20251001", "haiku-4.5"],
    ["Opus", "opus"],
    ["gpt-5.6-sol", "gpt-5.6-sol"],
  ])("shortens %s without discarding its version", (model, expected) => {
    expect(shortModel(model)).toBe(expected);
  });

  it("renders an absent version as the bare family without a placeholder", () => {
    const rendered = shortModel("Opus");
    expect(rendered).toBe("opus");
    expect(rendered).not.toContain("-");
    expect(rendered).not.toContain("undefined");
  });

  it("distinguishes Workers running different Opus majors", () => {
    expect(shortModel("claude-opus-5")).not.toBe(shortModel("claude-opus-4-8"));
  });
});
