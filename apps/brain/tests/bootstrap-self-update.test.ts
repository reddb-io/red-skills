import { describe, expect, it } from "vitest";
import {
  compareSemver,
  inRangeMajorTag,
  parseSemver,
  pointerFileName,
  readPointerVersion,
  sameMajor,
  selectInRangeUpdate,
  // @ts-expect-error — dependency-free .mjs bootstrap ships without type declarations
} from "../../../plugins/brain/scripts/bootstrap.mjs";

describe("in-range self-update policy (ADR 0084, mirror of packages/shared/self-update.ts)", () => {
  it("parseSemver reads a leading x.y.z and rejects junk", () => {
    expect(parseSemver("1.140.0")).toEqual({ major: 1, minor: 140, patch: 0 });
    expect(parseSemver("nope")).toBeNull();
  });

  it("compareSemver orders numerically, not lexically", () => {
    expect(compareSemver("1.9.0", "1.10.0")).toBeLessThan(0);
    expect(compareSemver("1.140.2", "1.140.2")).toBe(0);
  });

  it("sameMajor gates the compatible range", () => {
    expect(sameMajor("1.140.0", "1.999.9")).toBe(true);
    expect(sameMajor("1.140.0", "2.0.0")).toBe(false);
  });

  it("selectInRangeUpdate accepts a newer same-major, rejects out-of-range/downgrade", () => {
    expect(selectInRangeUpdate("1.140.0", "1.140.0", "1.145.0")).toBe("1.145.0");
    expect(selectInRangeUpdate("1.140.0", "1.140.0", "2.0.0")).toBeNull();
    expect(selectInRangeUpdate("1.140.0", "1.140.0", "1.140.0")).toBeNull();
    // Compares against `current`, not `installed`, so a done update is never re-picked.
    expect(selectInRangeUpdate("1.140.0", "1.145.0", "1.145.0")).toBeNull();
  });

  it("inRangeMajorTag is the floating major tag", () => {
    expect(inRangeMajorTag("1.140.0")).toBe("v1");
    expect(inRangeMajorTag("2.3.4")).toBe("v2");
  });

  it("pointerFileName / readPointerVersion round-trip", () => {
    expect(pointerFileName("brain")).toBe("brain-stable.current");
    expect(readPointerVersion(JSON.stringify({ version: "1.145.0" }))).toBe("1.145.0");
    expect(readPointerVersion("1.145.0")).toBe("1.145.0");
    expect(readPointerVersion("garbage")).toBe("");
  });
});
