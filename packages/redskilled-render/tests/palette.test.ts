/**
 * palette — the brand role table, pinned to the tokens that derive it.
 *
 * The table is NOT a fresh choice: every role resolves through
 * `@reddb-io/brand-tokens`, and asserting each role against its token name is
 * what stops a second palette from arriving under the same names (ADR 0137).
 * The one that would hurt most is the lifecycle ramp — it was deliberately
 * moved OFF a green/yellow traffic light (`0befc448e`) onto an intensity ramp,
 * and ADR 0137 explicitly rejected a brand-red bar; nothing here may quietly
 * move it to either.
 */
import { tokenToAnsiBackground, tokenToAnsiForeground } from "@reddb-io/brand-tokens";
import { describe, expect, it } from "vitest";
import * as palette from "../palette.js";

/** The SGR parameters of one escape — `\x1b[39m` → `39`. */
const params = (escape: string): string => escape.slice(2, -1);

describe("the brand role table, derived rather than re-picked", () => {
  it("grounds identity on the brand field and recedes the model block", () => {
    expect(palette.IDENTITY_BG).toBe(tokenToAnsiBackground("brand.primary"));
    expect(palette.IDENTITY_INK).toBe(tokenToAnsiForeground("brand.on-primary"));
    expect(palette.MODEL_BG).toBe(tokenToAnsiBackground("neutral.900"));
    expect(palette.PAPER).toBe(tokenToAnsiForeground("paper"));
  });

  it("keeps the transparent zone a neutral hierarchy over the terminal's own values", () => {
    expect(palette.KEY).toBe(tokenToAnsiForeground("paper"));
    expect(params(palette.VAL)).toBe("39");
    expect(palette.SOFT).toBe(tokenToAnsiForeground("neutral.400"));
    expect(palette.DIM).toBe(tokenToAnsiForeground("neutral.500"));
  });

  it("keeps the lifecycle bar an intensity ramp, not a traffic light or a brand bar", () => {
    expect(palette.BAR_DONE).toBe(tokenToAnsiForeground("neutral.300"));
    expect(palette.BAR_CURRENT).toBe(tokenToAnsiForeground("neutral.0"));
    expect(palette.BAR_AHEAD).toBe(tokenToAnsiForeground("neutral.700"));
  });

  it("spends the one saturated tone on failure alone", () => {
    expect(palette.SPOTLIGHT).toBe(tokenToAnsiForeground("red.500"));
  });

  it("publishes no gold: the brand publishes no feedback or accent yellows", () => {
    expect("GOLD" in palette).toBe(false);
  });

  it("states the structural codes a painted line needs to close itself", () => {
    expect(params(palette.RESET)).toBe("0");
    expect(params(palette.NOBG)).toBe("49");
    expect(params(palette.BOLD)).toBe("1");
    expect(params(palette.NOBOLD)).toBe("22");
  });

  it("emits SGR and nothing else, so the width primitives can measure it", () => {
    for (const [name, escape] of Object.entries(palette)) {
      expect(typeof escape, name).toBe("string");
      expect(escape, name).toMatch(/^\x1b\[[0-9;]*m$/);
    }
  });
});
