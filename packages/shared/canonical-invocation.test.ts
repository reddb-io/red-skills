import { describe, expect, it } from "vitest";
import {
  CANONICAL_VERSION_PLACEHOLDER,
  canonicalInvocation,
} from "./canonical-invocation.js";

describe("canonicalInvocation (#3071)", () => {
  it("spells the ADR 0091 npm direct-run form", () => {
    expect(canonicalInvocation("red-skills-redskilled", ["provision"], "3.0.4")).toBe(
      "npx -y -p @reddb-io/red-skills@3.0.4 red-skills-redskilled provision",
    );
  });

  it("falls back to a legible placeholder when the caller knows no version", () => {
    expect(canonicalInvocation("red-skills-dev", ["run", "--once"])).toBe(
      `npx -y -p @reddb-io/red-skills@${CANONICAL_VERSION_PLACEHOLDER} red-skills-dev run --once`,
    );
  });

  it("treats a blank version as unknown rather than emitting a bare @", () => {
    expect(canonicalInvocation("red-skills-dev", [], "   ")).toBe(
      `npx -y -p @reddb-io/red-skills@${CANONICAL_VERSION_PLACEHOLDER} red-skills-dev`,
    );
  });

  it("never emits a bare binary — the hint is read when PATH cannot be trusted", () => {
    const hint = canonicalInvocation("red-skills-redskilled", ["provision", "--install-unit"]);

    expect(hint.startsWith("npx -y -p @reddb-io/red-skills@")).toBe(true);
  });
});
