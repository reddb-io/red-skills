import { describe, expect, it } from "vitest";
import {
  applyCurrentBlockerEdit,
  formatCurrentBlocker,
  parseCurrentBlocker,
  upsertCurrentBlocker,
} from "../src/core/blocker-state.js";

const blocker = {
  status: "blocked" as const,
  kind: "validation",
  summary: "Gate failed on turbo lint step.",
  next: "Fix the ESLint rule violation and re-enqueue.",
};

describe("applyCurrentBlockerEdit — byte-exact round-trip", () => {
  it("returns changed=true and valid=true when the section is newly inserted", () => {
    const markdown = "## Summary\nContext here.\n";
    const { body, changed, valid } = applyCurrentBlockerEdit(markdown, blocker);

    expect(changed).toBe(true);
    expect(valid).toBe(true);
    expect(body).toContain("## Current blocker");
    expect(parseCurrentBlocker(body)).toEqual(blocker);
  });

  it("returns changed=false when the body already contains the exact blocker state", () => {
    const markdown = upsertCurrentBlocker("## Summary\nContext here.\n", blocker);
    const { body, changed, valid } = applyCurrentBlockerEdit(markdown, blocker);

    expect(changed).toBe(false);
    expect(valid).toBe(true);
    expect(body).toBe(markdown);
  });

  it("returns changed=true when an existing blocker is replaced with a different one", () => {
    const stale = {
      status: "blocked" as const,
      kind: "decision",
      summary: "Old question.",
      next: "Awaiting answer.",
    };
    const markdown = upsertCurrentBlocker("## Summary\nContext here.\n", stale);
    const { body, changed, valid } = applyCurrentBlockerEdit(markdown, blocker);

    expect(changed).toBe(true);
    expect(valid).toBe(true);
    expect(parseCurrentBlocker(body)).toEqual(blocker);
  });

  it("is idempotent: applying the edit twice leaves the body unchanged on the second pass", () => {
    const markdown = "## Summary\nContext here.\n";
    const { body: once } = applyCurrentBlockerEdit(markdown, blocker);
    const { body: twice, changed: secondChanged } = applyCurrentBlockerEdit(once, blocker);

    expect(secondChanged).toBe(false);
    expect(twice).toBe(once);
  });

  it("confirms round-trip integrity: parse-back matches the intended blocker", () => {
    const markdown = "## Summary\nContext.\n## Current blocker\n\n" + formatCurrentBlocker(blocker) + "\n";
    const { valid } = applyCurrentBlockerEdit(markdown, blocker);
    expect(valid).toBe(true);
  });

  it("preserves surrounding sections and does not drop content", () => {
    const markdown = [
      "## Summary",
      "Do this.",
      "",
      "## Current blocker",
      "",
      "Old text.",
      "",
      "## Acceptance",
      "- [ ] Done",
      "",
    ].join("\n");

    const { body, changed } = applyCurrentBlockerEdit(markdown, blocker);

    expect(changed).toBe(true);
    expect(body).toContain("## Summary\nDo this.");
    expect(body).toContain("## Acceptance\n- [ ] Done");
    expect(body).not.toContain("Old text.");
    expect(parseCurrentBlocker(body)).toEqual(blocker);
  });

  it("includes the optional ref field in round-trip when present", () => {
    const withRef = { ...blocker, ref: "#917" };
    const { body, changed, valid } = applyCurrentBlockerEdit("## Summary\nCtx.\n", withRef);

    expect(changed).toBe(true);
    expect(valid).toBe(true);
    expect(parseCurrentBlocker(body)).toEqual(withRef);

    const { changed: noop } = applyCurrentBlockerEdit(body, withRef);
    expect(noop).toBe(false);
  });
});
