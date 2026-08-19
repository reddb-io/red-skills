// Is the plugin that answers actually current? (#3147)
//
// Two update lanes exist and only one was watched. The BUNDLE lane self-updates
// and reports; the PLUGIN lane — the host's install, carrying the MCP server —
// sat eight releases behind while `red-doctor` said `marketplace findings: 0`.
//
// The skew is invisible from outside: the MCP server COMPOSES a registration, so
// an old one registers with an empty launch environment and writes the CURRENT
// bundle path into the argv. A fresh Worker running new code, born from a
// registration composed by old code, and every version on screen true about
// something else.
import { describe, expect, it } from "vitest";
import {
  PLUGIN_VERSION_STALE_AFTER,
  compareVersions,
  judgePluginVersion,
} from "../src/core/plugin-version-doctor.js";

describe("compareVersions", () => {
  it("orders by major, minor then patch", () => {
    expect(compareVersions("3.3.9", "3.3.17")).toBeLessThan(0);
    expect(compareVersions("3.4.0", "3.3.17")).toBeGreaterThan(0);
    expect(compareVersions("3.3.9", "3.3.9")).toBe(0);
  });

  it("is null rather than a guess when either side is not a version", () => {
    expect(compareVersions("latest", "3.3.9")).toBeNull();
    expect(compareVersions(null, "3.3.9")).toBeNull();
  });
});

describe("judgePluginVersion", () => {
  it("calls the exact gap this issue was filed for", () => {
    const report = judgePluginVersion({ installed: "3.3.9", published: "3.3.17" });
    expect(report.verdict).toBe("stale");
    expect(report.behindBy).toBe(8);
    // Both numbers in the sentence: an operator who reads nothing else must
    // still know what is installed and what shipped.
    expect(report.detail).toContain("3.3.9");
    expect(report.detail).toContain("3.3.17");
    expect(report.fix).toContain("marketplace");
    expect(report.fix).toContain("restart");
  });

  it("names WHY it matters, not only that it is behind", () => {
    // The MCP server composes a registration; that is the whole reason a stale
    // plugin is not cosmetic, and the report is where a reader learns it.
    expect(judgePluginVersion({ installed: "3.3.9", published: "3.3.17" }).detail)
      .toContain("registration");
  });

  it("is quiet when current or ahead", () => {
    expect(judgePluginVersion({ installed: "3.3.17", published: "3.3.17" }).verdict).toBe("current");
    expect(judgePluginVersion({ installed: "3.4.0", published: "3.3.17" }).verdict).toBe("current");
  });

  it("distinguishes one release behind from a real skew", () => {
    expect(judgePluginVersion({ installed: "3.3.16", published: "3.3.17" }).verdict).toBe("behind");
    const stale = judgePluginVersion({
      installed: "3.3.15",
      published: `3.3.${15 + PLUGIN_VERSION_STALE_AFTER}`,
    });
    expect(stale.verdict).toBe("stale");
  });

  it("treats an unaskable registry as UNKNOWN, never as current", () => {
    // Unknown read as a negative is the confusion this repo has hit in four
    // organs; reporting "up to date" because npm was unreachable would be a
    // fifth, and the loudest, because it certifies the machine.
    const report = judgePluginVersion({ installed: "3.3.9", published: null });
    expect(report.verdict).toBe("unknown");
    expect(report.detail).toContain("unknown is not current");
    expect(report.fix).toBeNull();
  });

  it("reports an absent install rather than pretending it is current", () => {
    expect(judgePluginVersion({ installed: null, published: "3.3.17" }).verdict).toBe("absent");
  });

  it("says unknown when a version cannot be compared, and never crashes", () => {
    expect(judgePluginVersion({ installed: "nightly", published: "3.3.17" }).verdict).toBe("unknown");
  });

  it("does not claim a patch distance across a minor bump", () => {
    // 3.2.9 → 3.3.1 is not "negative eight releases".
    const report = judgePluginVersion({ installed: "3.2.9", published: "3.3.1" });
    expect(report.behindBy).toBeNull();
    expect(report.verdict).toBe("stale");
  });
});
