import type { AdversarialReviewFindings } from "../../src/core/adversarial-review.js";

export function defaultAdversarialFindings(): AdversarialReviewFindings {
  return {
    summary: "Stubbed adversarial review summary.",
    score: 0.5,
    findings: [
      {
        path: "packages/x/src/a.ts",
        line: 1,
        body: "Acceptance criteria conformance finding.",
        blocking: true,
      },
    ],
  };
}
