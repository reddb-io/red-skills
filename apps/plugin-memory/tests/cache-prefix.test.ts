import { describe, expect, test } from "vitest";
import {
  VOLATILE_MARKER,
  containsDynamicToken,
  stabilizeCachePrefix,
} from "../src/cache-prefix.js";

describe("cache-prefix stability", () => {
  test("relocates dynamic tokens to the end and keeps a dynamic-free stable prefix", () => {
    const prompt = [
      "# Memory handoff",
      "Focus: jwt rotation",
      "- Finish JWT rotation (8d old) — continue after cache TTL [task:jwt#1]",
      "Generated at 2026-06-22T15:07:43.000Z",
    ].join("\n");

    const result = stabilizeCachePrefix(prompt);

    // The stable prefix carries the structure but none of the dynamic values.
    expect(result.relocatedCount).toBe(2);
    expect(containsDynamicToken(result.stablePrefix)).toBe(false);
    expect(result.stablePrefix).toContain("# Memory handoff");
    expect(result.stablePrefix).toContain("Finish JWT rotation");

    // Dynamic content is moved to the end, after the volatile marker.
    const markerIndex = result.text.indexOf(VOLATILE_MARKER);
    expect(markerIndex).toBeGreaterThan(0);
    expect(result.text.indexOf("8d old")).toBeGreaterThan(markerIndex);
    expect(result.text.indexOf("2026-06-22T15:07:43.000Z")).toBeGreaterThan(markerIndex);
    expect(result.volatileValues).toEqual(["8d old", "2026-06-22T15:07:43.000Z"]);
  });

  test("two prompts differing only in dynamic values share an identical stable prefix", () => {
    const render = (age: string, at: string) =>
      [
        "# Memory handoff",
        "Focus: jwt rotation",
        `- Finish JWT rotation (${age}) — continue after cache TTL [task:jwt#1]`,
        `Generated at ${at}`,
      ].join("\n");

    const a = stabilizeCachePrefix(render("8d old", "2026-06-22T15:07:43.000Z"));
    const b = stabilizeCachePrefix(render("12d old", "2026-06-23T09:00:00.000Z"));

    expect(a.stablePrefix).toBe(b.stablePrefix);
    // ...but the full emitted prompts still differ (the relocated tail differs).
    expect(a.text).not.toBe(b.text);
  });

  test("text without dynamic tokens is returned unchanged (safe no-op)", () => {
    const prompt = "# Memory context pack: ship feature\n\nStatus: ok\n- decision [decision:x#3]";
    const result = stabilizeCachePrefix(prompt);

    expect(result.relocatedCount).toBe(0);
    expect(result.text).toBe(prompt);
    expect(result.stablePrefix).toBe(prompt);
    expect(result.volatileValues).toEqual([]);
    expect(result.text).not.toContain(VOLATILE_MARKER);
  });

  test("stable identifiers (recall scores, citation rids) are not relocated", () => {
    const prompt = "- decision (trust: 0.50; importance: 0.95; urn: urn:memory:decision#42)";
    const result = stabilizeCachePrefix(prompt);

    expect(result.relocatedCount).toBe(0);
    expect(result.text).toBe(prompt);
  });
});
