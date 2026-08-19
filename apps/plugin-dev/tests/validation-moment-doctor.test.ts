import { describe, expect, it } from "vitest";
import { auditValidationMomentDrift } from "../src/core/validation-moment-doctor.js";

describe("red-doctor — Validation declaration/engine drift", () => {
  it("reports a configured moment the engine does not implement", () => {
    const report = auditValidationMomentDrift({
      configuredMoments: ["iteration", "correction"],
      declarationMoments: ["iteration", "post_done", "landing"],
      engineMoments: ["iteration", "post_done", "landing"],
    });

    expect(report.verdict).toBe("drift");
    expect(report.findings).toEqual([
      {
        kind: "unsupported-declaration",
        moment: "correction",
        reason: "afk.validation.correction is declared but the engine has no such Validation moment",
        remediation: "remove or rename the declaration to iteration, post_done, or landing",
      },
    ]);
  });

  it("stays green when configured, declarable, and engine moments match", () => {
    expect(auditValidationMomentDrift({
      configuredMoments: ["iteration", "landing"],
      declarationMoments: ["iteration", "post_done", "landing"],
      engineMoments: ["iteration", "post_done", "landing"],
    })).toEqual({ verdict: "ok", findings: [] });
  });
});
