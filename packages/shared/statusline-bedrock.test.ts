/**
 * statusline-bedrock — the half of the line the machine can always answer.
 *
 * The block renderers keep their own exhaustive suite in the dev app, which has
 * asked this module for them since they moved down here. What this file pins is
 * the BEDROCK's own contract: which blocks it assembles, in what order, and that
 * the seam it draws against the daemon tail survives a tail that produced
 * nothing — the case the whole segment exists for.
 */
import { describe, expect, it } from "vitest";
import {
  composeStatuslineLines,
  humanizeTokens,
  renderBedrockProjectBlock,
  renderContextBlock,
  renderLocalDiffBlock,
  renderModelBlock,
  renderProjectBlock,
  renderProjectVersionLabel,
  renderStatuslineBedrock,
  renderUsageBlock,
  type StatuslineBedrockInput,
} from "./statusline-bedrock.js";

const FULL: StatuslineBedrockInput = {
  project: { basename: "red-skills", branch: "main", version: "4.1.22" },
  claude: {
    model: "Fable 5",
    effort: "high",
    contextTokens: 47_000,
    contextPercent: 24,
    usage5h: 23,
    usage7d: 41,
  },
  localDiff: { localAdded: 142, localRemoved: 36 },
};

describe("renderStatuslineBedrock assembles the zero-network half", () => {
  it("puts project, model, context, usage and local diff on one line, in order", () => {
    expect(renderStatuslineBedrock(FULL)).toBe(
      "red-skills (main) v4.1.22 Fable 5·high ctx=47k 24% 5h=23% 7d=41% loc=+142 -36",
    );
  });

  it("still renders the project block when the host payload never arrived", () => {
    expect(renderStatuslineBedrock({ project: { basename: "red-skills", branch: "main" } })).toBe(
      "red-skills (main)",
    );
  });

  it("states the version unconditionally, unlike the header's own project block", () => {
    const project = { basename: "red-skills", version: "4.1.22" };
    expect(renderBedrockProjectBlock(project)).toBe("red-skills v4.1.22");
    expect(renderProjectBlock(project)).toBe("red-skills");
    expect(renderProjectVersionLabel(project, "update-only")).toBeNull();
  });

  it("drops a diff block that is all zeroes rather than printing noise", () => {
    expect(renderLocalDiffBlock({ localAdded: 0, localRemoved: 0 })).toBeNull();
    expect(renderLocalDiffBlock(undefined)).toBeNull();
  });

  it("drops each payload block the host did not supply", () => {
    expect(renderModelBlock({})).toBeNull();
    expect(renderContextBlock({ contextTokens: 0 })).toBeNull();
    expect(renderUsageBlock({})).toBeNull();
    expect(humanizeTokens(47_000)).toBe("47k");
  });
});

describe("humanizeTokens is the line's ONE spelling of a large number", () => {
  it("keeps its default shape, so no existing cell changes width", () => {
    expect(humanizeTokens(940)).toBe("940");
    expect(humanizeTokens(12_400)).toBe("12k");
    expect(humanizeTokens(2_400_000)).toBe("2.4M");
  });

  it("keeps the thousands digit for a caller that asks, and drops a bare .0", () => {
    expect(humanizeTokens(12_400, { fractionalThousands: true })).toBe("12.4k");
    expect(humanizeTokens(3_100, { fractionalThousands: true })).toBe("3.1k");
    expect(humanizeTokens(12_000, { fractionalThousands: true })).toBe("12k");
    expect(humanizeTokens(940, { fractionalThousands: true })).toBe("940");
    expect(humanizeTokens(2_400_000, { fractionalThousands: true })).toBe("2.4M");
  });
});

describe("composeStatuslineLines draws the bedrock/tail seam", () => {
  it("leads the header with the bedrock and passes the rest of the tail through", () => {
    expect(composeStatuslineLines("BEDROCK", ["head line", "worker row"])).toEqual([
      "BEDROCK · head line",
      "worker row",
    ]);
  });

  it("leaves the bedrock alone rather than a dangling separator when no tail came", () => {
    expect(composeStatuslineLines("BEDROCK", [])).toEqual(["BEDROCK"]);
    expect(composeStatuslineLines("BEDROCK", ["", "  "])).toEqual(["BEDROCK"]);
  });
});
