/**
 * palette — the wine family, pinned to the values it was lifted from (#3150).
 *
 * The table is NOT a fresh choice: every tone is `apps/dev/src/core/statusline-style.ts`
 * verbatim, and asserting the SGR parameters is what stops a second palette from
 * arriving under the same names. The one that would hurt most is the lifecycle
 * ramp — it was deliberately moved OFF a green/yellow traffic light (`0befc448e`)
 * onto three steps of the wine family, and nothing here may quietly move it back.
 */
import { describe, expect, it } from "vitest";
import * as palette from "../palette.js";

/** The SGR parameters of one escape — `\x1b[38;2;255;95;95m` → `38;2;255;95;95`. */
const params = (escape: string): string => escape.slice(2, -1);

describe("the wine identity family, lifted rather than re-picked", () => {
  it("states each identity tone at the parameters it was chosen with", () => {
    expect(params(palette.WINE)).toBe("48;2;114;47;55");
    expect(params(palette.WINE2)).toBe("48;2;88;36;42");
    expect(params(palette.KEY)).toBe("38;2;255;214;214");
    expect(params(palette.VAL)).toBe("39");
    expect(params(palette.SOFT)).toBe("38;2;224;138;148");
    expect(params(palette.DIM)).toBe("38;2;201;150;158");
    expect(params(palette.WHITE)).toBe("38;2;255;255;255");
  });

  it("keeps the lifecycle bar on the wine ramp, not on a traffic light", () => {
    expect(params(palette.BAR_DONE)).toBe("38;2;240;110;120");
    expect(params(palette.BAR_CURRENT)).toBe("38;2;255;214;214");
    expect(params(palette.BAR_AHEAD)).toBe("38;2;146;84;94");
  });

  it("spends the one saturated tone on failure alone", () => {
    expect(params(palette.RED)).toBe("38;2;255;95;95");
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
