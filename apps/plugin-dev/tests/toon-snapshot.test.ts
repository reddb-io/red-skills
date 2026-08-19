import { decode, encode } from "@reddb-io/toon";
import { describe, expect, it } from "vitest";
import { assertDevSnapshotToonLossless, encodeDevSnapshotToon } from "../src/core/toon-snapshot.js";

describe("dev snapshot TOON encoding", () => {
  it("encodes qualifying keyed maps in the current counted form", () => {
    const snapshot = {
      statusline_counts: {
        before: { queue: 8, human: 2, ts: 100 },
        after: { queue: 7, human: 3, ts: 200 },
      },
    };

    const toon = assertDevSnapshotToonLossless(snapshot);

    expect(toon).toContain("statusline_counts[2:]{queue,human,ts}:");
    expect(toon).toContain("before: 8,2,100");
    expect(toon).toContain("after: 7,3,200");
    expect(decode(toon)).toEqual(snapshot);
  });

  it("leaves non-qualifying flat statusline caches on default encoding", () => {
    const cache = { queue: 8, human: 2, ts: 100 };

    expect(encodeDevSnapshotToon(cache)).toBe(encode(cache));
  });

  it("leaves non-uniform maps on default encoding", () => {
    const snapshot = {
      repo_caches: {
        current: { openPrs: 2, openIssues: 10, ts: 100 },
        previous: { openPrs: 1, todayPrs: 1, openIssues: 9, ts: 50 },
      },
    };

    const toon = assertDevSnapshotToonLossless(snapshot);

    expect(toon).not.toContain("repo_caches{");
    expect(decode(toon)).toEqual(snapshot);
  });

  it("decodes current counted keyed maps and mixed documents", () => {
    const counted = "attempts[2:]{runner,issue,phase}:\n  wAAAA: codex,1826,tests\n  wBBBB: claude,1827,done\n";
    const nonCollapsed = encode({
      attempts: {
        wAAAA: { runner: "codex", issue: 1826, phase: "tests" },
        wBBBB: { runner: "claude", issue: 1827, phase: "done" },
      },
    });
    const mixed = [
      "attempts[2:]{runner,issue,phase}:",
      "  wAAAA: codex,1826,tests",
      "  wBBBB: claude,1827,done",
      "repo_cache:",
      "  openPrs: 4",
      "  openIssues: 12",
      "  ts: 300",
      "",
    ].join("\n");

    expect(decode(counted)).toEqual(decode(nonCollapsed));
    expect(decode(mixed)).toEqual({
      attempts: {
        wAAAA: { runner: "codex", issue: 1826, phase: "tests" },
        wBBBB: { runner: "claude", issue: 1827, phase: "done" },
      },
      repo_cache: { openPrs: 4, openIssues: 12, ts: 300 },
    });
  });
});
