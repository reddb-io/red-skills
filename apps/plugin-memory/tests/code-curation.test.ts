import { describe, expect, test } from "vitest";
import {
  EMPTY_ENGINEERING_CODE_CURATION,
  aliasEngineeringCode,
  isCuratedSuggestedEngineeringCode,
  promoteEngineeringCode,
  resolveEngineeringCodeAlias,
  suggestedEngineeringCodes,
} from "../src/code-curation.js";

describe("engineering-code curation (ADR 0035, #309)", () => {
  test("promotes a recurring unknown into the suggested vocabulary", () => {
    const result = promoteEngineeringCode(EMPTY_ENGINEERING_CODE_CURATION, "Incident Pattern");

    expect(result.changed).toBe(true);
    expect(result.state.promoted).toEqual(["incident-pattern"]);
    expect(suggestedEngineeringCodes(result.state)).toContain("incident-pattern");
    expect(isCuratedSuggestedEngineeringCode("incident pattern", result.state)).toBe(true);
  });

  test("aliases a synonym to a canonical code without changing the stored synonym", () => {
    const result = aliasEngineeringCode(EMPTY_ENGINEERING_CODE_CURATION, "Foot Gun", "gotcha");

    expect(result.changed).toBe(true);
    expect(result.state.aliases).toEqual([{ from: "foot-gun", to: "gotcha" }]);
    expect(resolveEngineeringCodeAlias("foot gun", result.state)).toBe("gotcha");
    expect(isCuratedSuggestedEngineeringCode("foot gun", result.state)).toBe(true);
  });

  test("rejects alias cycles so the open axis has a bounded resolution path", () => {
    const first = aliasEngineeringCode(EMPTY_ENGINEERING_CODE_CURATION, "a", "b").state;

    expect(() => aliasEngineeringCode(first, "b", "a")).toThrow(/alias cycle/);
  });
});
