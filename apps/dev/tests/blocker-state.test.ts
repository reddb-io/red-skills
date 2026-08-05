import { describe, expect, it } from "vitest";
import {
  MALFORMED_BLOCKER_STATE,
  clearCurrentBlocker,
  formatCurrentBlocker,
  parseCurrentBlocker,
  upsertCurrentBlocker,
} from "../src/core/blocker-state.js";

describe("blocker-state", () => {
  const blocker = {
    status: "blocked" as const,
    kind: "decision",
    ref: "#856",
    summary: "Phase 2 measured no decode-layer win.",
    next: "Human must decide stop, redesign, or continue anyway.",
  };

  it("formats and parses the machine-readable current blocker block", () => {
    const markdown = `## Current blocker\n\n${formatCurrentBlocker(blocker)}\n`;
    expect(parseCurrentBlocker(markdown)).toEqual(blocker);
  });

  it("ignores resolved or malformed blocker blocks", () => {
    expect(parseCurrentBlocker("## Current blocker\n\nNone\n")).toBeNull();
    expect(parseCurrentBlocker("<!-- red:blocker-state v1 -->\nstatus: resolved\n<!-- /red:blocker-state -->")).toBeNull();
  });

  it("fails closed on a malformed active block and names the repair defect", () => {
    const malformed = [
      "<!-- red:blocker-state v1 -->",
      "status: blocked",
      "kind: push-failed",
      "<!-- /red:blocker-state -->",
    ].join("\n");

    expect(parseCurrentBlocker(malformed)).toMatchObject({
      status: "blocked",
      kind: "push-failed",
      defect: {
        name: MALFORMED_BLOCKER_STATE,
        missingFields: ["summary", "next"],
      },
    });
  });

  it("upserts the Current blocker section without touching later sections", () => {
    const body = "## Summary\nDo this.\n\n## Current blocker\n\nOld text.\n\n## Acceptance\n- [ ] Done\n";
    const next = upsertCurrentBlocker(body, blocker);
    expect(next).toContain("## Summary\nDo this.");
    expect(next).toContain("## Current blocker\n\n<!-- red:blocker-state v1 -->");
    expect(next).toContain("summary: Phase 2 measured no decode-layer win.");
    expect(next).toContain("## Acceptance\n- [ ] Done");
    expect(next).not.toContain("Old text.");
  });

  it("clears the active blocker and records it under Resolved blockers", () => {
    const body = upsertCurrentBlocker("## Summary\nDo this.\n", blocker);
    const next = clearCurrentBlocker(body, {
      summary: blocker.summary,
      resolution: "Continue only after redesigning the decode path.",
    });

    expect(parseCurrentBlocker(next)).toBeNull();
    expect(next).toContain("## Current blocker\n\nNone");
    expect(next).toContain("## Resolved blockers");
    expect(next).toContain("- [x] Phase 2 measured no decode-layer win. - Continue only after redesigning the decode path.");
  });
});
