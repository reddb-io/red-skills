import { describe, expect, test } from "vitest";
import {
  DEFAULT_RECURRING_THRESHOLD,
  buildCodeDriftReport,
} from "../src/code-drift-report.js";
import { EXTRACTION_SCHEMA_VERSION } from "../src/extraction-schema.js";
import {
  EMPTY_ENGINEERING_CODE_CURATION,
  aliasEngineeringCode,
  isCuratedSuggestedEngineeringCode,
  resolveEngineeringCodeAlias,
} from "../src/code-curation.js";

describe("code drift report (ADR 0035, #307)", () => {
  test("groups unknown codes by recurrence count and separates recurring from one-off", () => {
    const report = buildCodeDriftReport([
      "footgun",
      "footgun",
      "footgun",
      "smell",
      "smell",
      "yak-shave",
      "decision",
      "gotcha",
      "gotcha",
    ]);

    expect(report.knownCount).toBe(3);
    expect(report.unknownCount).toBe(6);
    expect(report.distinctUnknown).toBe(3);
    expect(report.entries).toEqual([
      { code: "footgun", count: 3, recurrence: "recurring" },
      { code: "smell", count: 2, recurrence: "recurring" },
      { code: "yak-shave", count: 1, recurrence: "one-off" },
    ]);
    expect(report.groups).toEqual([
      { count: 3, recurrence: "recurring", codes: ["footgun"] },
      { count: 2, recurrence: "recurring", codes: ["smell"] },
      { count: 1, recurrence: "one-off", codes: ["yak-shave"] },
    ]);
    expect(report.recurring.map((entry) => entry.code)).toEqual(["footgun", "smell"]);
    expect(report.oneOff.map((entry) => entry.code)).toEqual(["yak-shave"]);
    expect(report.recurringThreshold).toBe(DEFAULT_RECURRING_THRESHOLD);
    expect(report.schemaVersion).toBe(EXTRACTION_SCHEMA_VERSION);
    expect(report.suggestedVersion).toBe(EXTRACTION_SCHEMA_VERSION);
  });

  test("normalizes codes before counting so variants collapse onto one entry", () => {
    const report = buildCodeDriftReport(["Foot Gun", "foot-gun", "FOOT_GUN"]);
    expect(report.entries).toEqual([{ code: "foot-gun", count: 3, recurrence: "recurring" }]);
    expect(report.groups).toEqual([{ count: 3, recurrence: "recurring", codes: ["foot-gun"] }]);
  });

  test("ignores absent, blank, and punctuation-only codes", () => {
    const report = buildCodeDriftReport([undefined, null, "", "   ", "***", "real-code"]);
    expect(report.totalCoded).toBe(1);
    expect(report.entries).toEqual([{ code: "real-code", count: 1, recurrence: "one-off" }]);
  });

  test("a vocabulary of only known codes yields an empty unknown tail", () => {
    const report = buildCodeDriftReport(["decision", "gotcha", "risk", "root-cause"]);
    expect(report.knownCount).toBe(4);
    expect(report.distinctUnknown).toBe(0);
    expect(report.entries).toEqual([]);
    expect(report.groups).toEqual([]);
    expect(report.recurring).toEqual([]);
    expect(report.oneOff).toEqual([]);
  });

  test("the recurring threshold is configurable with a floor of 2", () => {
    const codes = ["a", "a", "b", "b", "b", "c"];
    const t3 = buildCodeDriftReport(codes, { recurringThreshold: 3 });
    expect(t3.groups).toEqual([
      { count: 3, recurrence: "recurring", codes: ["b"] },
      { count: 2, recurrence: "one-off", codes: ["a"] },
      { count: 1, recurrence: "one-off", codes: ["c"] },
    ]);
    expect(t3.recurring.map((entry) => entry.code)).toEqual(["b"]);
    expect(t3.oneOff.map((entry) => entry.code)).toEqual(["a", "c"]);

    const clamped = buildCodeDriftReport(["x"], { recurringThreshold: 1 });
    expect(clamped.recurringThreshold).toBe(2);
    expect(clamped.oneOff.map((entry) => entry.code)).toEqual(["x"]);
  });

  test("an injected suggested predicate decides what counts as known", () => {
    const report = buildCodeDriftReport(["alpha", "alpha", "beta"], {
      isSuggested: (code) => code === "alpha",
    });
    expect(report.knownCount).toBe(2);
    expect(report.entries).toEqual([{ code: "beta", count: 1, recurrence: "one-off" }]);
  });

  test("explicit aliases resolve synonyms before drift grouping", () => {
    const curation = aliasEngineeringCode(
      EMPTY_ENGINEERING_CODE_CURATION,
      "footgun",
      "gotcha",
    ).state;
    const report = buildCodeDriftReport(["footgun", "footgun", "gotcha", "smell"], {
      curation,
      canonicalize: (code) => resolveEngineeringCodeAlias(code, curation),
      isSuggested: (code) => isCuratedSuggestedEngineeringCode(code, curation),
    });

    expect(report.knownCount).toBe(3);
    expect(report.entries).toEqual([{ code: "smell", count: 1, recurrence: "one-off" }]);
  });
});
