import { describe, expect, it } from "vitest";
import { classifyRouteKind, isSessionBound } from "../src/core/manager/router.js";

describe("classifyRouteKind — session-bound skills (Spec #2290 Decision #2182)", () => {
  it.each(["start", "research", "to-spec", "to-tickets"])(
    "classifies %s as session-bound",
    (skill) => {
      expect(classifyRouteKind(skill)).toBe("session-bound");
    },
  );
});

describe("classifyRouteKind — autonomous skills (Spec #2290 Decision #2182)", () => {
  it.each(["afk", "go"])("classifies %s as autonomous", (skill) => {
    expect(classifyRouteKind(skill)).toBe("autonomous");
  });
});

describe("classifyRouteKind — unknown skills", () => {
  it("returns unknown for a skill not in the ask-red routing inventory", () => {
    expect(classifyRouteKind("not-a-skill")).toBe("unknown");
    expect(classifyRouteKind("")).toBe("unknown");
    expect(classifyRouteKind("to-tickets-extra")).toBe("unknown");
  });
});

describe("isSessionBound", () => {
  it("returns true only for session-bound skills", () => {
    expect(isSessionBound("to-spec")).toBe(true);
    expect(isSessionBound("to-tickets")).toBe(true);
    expect(isSessionBound("afk")).toBe(false);
    expect(isSessionBound("go")).toBe(false);
    expect(isSessionBound("unknown-skill")).toBe(false);
  });
});
