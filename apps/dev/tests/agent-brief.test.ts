import { describe, expect, it } from "vitest";
import {
  AGENT_BRIEF_CLOSE,
  AGENT_BRIEF_OPEN,
  applyAgentBriefEdit,
  upsertAgentBrief,
} from "../src/core/agent-brief.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Extract the bytes before and after the anchored region. */
function outerBytes(markdown: string): { before: string; after: string } {
  const openIdx = markdown.indexOf(AGENT_BRIEF_OPEN);
  const closeIdx = markdown.indexOf(AGENT_BRIEF_CLOSE);
  if (openIdx === -1 || closeIdx === -1) return { before: markdown, after: "" };
  return {
    before: markdown.slice(0, openIdx),
    after: markdown.slice(closeIdx + AGENT_BRIEF_CLOSE.length),
  };
}

// ---------------------------------------------------------------------------
// upsertAgentBrief — fast path (anchors already present)
// ---------------------------------------------------------------------------

describe("upsertAgentBrief — fast path (anchors present) (#994)", () => {
  const withAnchors = [
    "## Summary",
    "The original summary.",
    "",
    "## Agent brief",
    "",
    AGENT_BRIEF_OPEN,
    "Old brief content.",
    AGENT_BRIEF_CLOSE,
    "",
    "## Acceptance criteria",
    "- [ ] Keep this.",
    "",
  ].join("\n");

  it("replaces inner content; bytes outside the anchored region are byte-identical", () => {
    const before = outerBytes(withAnchors);
    const out = upsertAgentBrief(withAnchors, "New brief content.");
    const after = outerBytes(out);

    expect(after.before).toBe(before.before);
    expect(after.after).toBe(before.after);
    expect(out).toContain("New brief content.");
    expect(out).not.toContain("Old brief content.");
  });

  it("is a no-op (same reference) when the content is already correct", () => {
    const out = upsertAgentBrief(withAnchors, "Old brief content.");
    expect(out).toBe(withAnchors);
  });

  it("preserves the surrounding sections byte-for-byte", () => {
    const out = upsertAgentBrief(withAnchors, "Changed.");
    expect(out).toContain("## Summary\nThe original summary.");
    expect(out).toContain("## Acceptance criteria\n- [ ] Keep this.");
  });
});

// ---------------------------------------------------------------------------
// upsertAgentBrief — fallback (no anchors yet)
// ---------------------------------------------------------------------------

describe("upsertAgentBrief — fallback (no anchors yet) (#994)", () => {
  it("injects anchors when the section exists but lacks them", () => {
    const body = "## Summary\nExisting.\n\n## Agent brief\nOld brief.\n\n## Acceptance\n- [ ] Keep.\n";
    const out = upsertAgentBrief(body, "New brief.");
    expect(out).toContain(AGENT_BRIEF_OPEN);
    expect(out).toContain(AGENT_BRIEF_CLOSE);
    expect(out).toContain("New brief.");
    expect(out).not.toContain("Old brief.");
    expect(out.match(/## Agent brief/g)).toHaveLength(1);
  });

  it("appends an anchored section when no heading exists", () => {
    const body = "## Summary\nExisting.\n";
    const out = upsertAgentBrief(body, "New brief.");
    expect(out).toContain("## Agent brief");
    expect(out).toContain(AGENT_BRIEF_OPEN);
    expect(out).toContain("New brief.");
    expect(out).toContain("## Summary\nExisting.");
  });

  it("a second call with anchors now in place uses the fast path", () => {
    const first = upsertAgentBrief("## Summary\nExisting.\n", "Brief v1.");
    const before = outerBytes(first);
    const second = upsertAgentBrief(first, "Brief v2.");
    const after = outerBytes(second);

    expect(second).toContain("Brief v2.");
    expect(second).not.toContain("Brief v1.");
    // Bytes outside the anchored region are preserved byte-for-byte on the second call.
    expect(after.before).toBe(before.before);
    expect(after.after).toBe(before.after);
  });
});

// ---------------------------------------------------------------------------
// applyAgentBriefEdit — round-trip validation
// ---------------------------------------------------------------------------

describe("applyAgentBriefEdit (#994)", () => {
  it("reports changed=false when the body is already correct", () => {
    const body = upsertAgentBrief("## Summary\nExisting.\n", "Stable brief.");
    const result = applyAgentBriefEdit(body, "Stable brief.");
    expect(result.changed).toBe(false);
    expect(result.valid).toBe(true);
    expect(result.body).toBe(body);
  });

  it("reports changed=true and valid=true for a fresh update", () => {
    const body = upsertAgentBrief("## Summary\nExisting.\n", "Old brief.");
    const result = applyAgentBriefEdit(body, "New brief.");
    expect(result.changed).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.body).toContain("New brief.");
  });

  it("outer bytes are unchanged on fast-path edit", () => {
    const initial = upsertAgentBrief(
      "## Summary\nBefore.\n\n## Notes\nAfter.\n",
      "Initial.",
    );
    const before = outerBytes(initial);
    const { body } = applyAgentBriefEdit(initial, "Updated.");
    const after = outerBytes(body);
    expect(after.before).toBe(before.before);
    expect(after.after).toBe(before.after);
  });
});
