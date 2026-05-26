import { describe, expect, it } from "vitest";

import {
  CONFIDENCE_WEIGHTS,
  PROVENANCE_SATURATION,
  pathConfidence,
  scoreConfidence,
  type ConfidenceSignals,
  type SupersessionStatus,
} from "../src/confidence-scoring.js";

const baseline: ConfidenceSignals = {
  provenance_depth: PROVENANCE_SATURATION,
  recency: 1,
  supersession_status: "active",
  validation_signal: 1,
};

interface Case {
  name: string;
  signals: ConfidenceSignals;
  expectedConfidence: number;
  expectedComponents: {
    provenance: number;
    recency: number;
    supersession: number;
    validation: number;
  };
}

const cases: Case[] = [
  {
    name: "fully grounded, fresh, active, confirmed → 1.0",
    signals: baseline,
    expectedConfidence: 1,
    expectedComponents: { provenance: 1, recency: 1, supersession: 1, validation: 1 },
  },
  {
    name: "ungrounded, stale, superseded, contradicted → 0.075",
    signals: {
      provenance_depth: 0,
      recency: 0,
      supersession_status: "superseded",
      validation_signal: -1,
    },
    expectedConfidence:
      0 * CONFIDENCE_WEIGHTS.provenance +
      0 * CONFIDENCE_WEIGHTS.recency +
      0.3 * CONFIDENCE_WEIGHTS.supersession +
      0 * CONFIDENCE_WEIGHTS.validation,
    expectedComponents: { provenance: 0, recency: 0, supersession: 0.3, validation: 0 },
  },
  {
    name: "single-source, fresh, active, neutral validation",
    signals: {
      provenance_depth: 1,
      recency: 1,
      supersession_status: "active",
      validation_signal: 0,
    },
    expectedConfidence:
      (1 / PROVENANCE_SATURATION) * CONFIDENCE_WEIGHTS.provenance +
      1 * CONFIDENCE_WEIGHTS.recency +
      1 * CONFIDENCE_WEIGHTS.supersession +
      0.5 * CONFIDENCE_WEIGHTS.validation,
    expectedComponents: {
      provenance: round3(1 / PROVENANCE_SATURATION),
      recency: 1,
      supersession: 1,
      validation: 0.5,
    },
  },
  {
    name: "superseding head ranked as good as active",
    signals: { ...baseline, supersession_status: "superseding" },
    expectedConfidence: 1,
    expectedComponents: { provenance: 1, recency: 1, supersession: 1, validation: 1 },
  },
];

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

describe("scoreConfidence", () => {
  for (const tc of cases) {
    it(tc.name, () => {
      const result = scoreConfidence(tc.signals);
      expect(result.confidence).toBeCloseTo(round3(tc.expectedConfidence), 3);
      expect(result.components).toEqual(tc.expectedComponents);
      expect(result.policy.weights).toEqual(CONFIDENCE_WEIGHTS);
      expect(result.policy.provenance_saturation).toBe(PROVENANCE_SATURATION);
    });
  }

  it("clamps confidence into [0, 1]", () => {
    expect(scoreConfidence(baseline).confidence).toBeLessThanOrEqual(1);
    expect(
      scoreConfidence({
        provenance_depth: -5,
        recency: -1,
        supersession_status: "superseded",
        validation_signal: -10,
      }).confidence,
    ).toBeGreaterThanOrEqual(0);
  });

  it("treats non-finite signals defensively", () => {
    const result = scoreConfidence({
      provenance_depth: Number.NaN,
      recency: Number.POSITIVE_INFINITY,
      supersession_status: "active",
      validation_signal: Number.NaN,
    });
    expect(result.components.provenance).toBe(0);
    expect(result.components.recency).toBe(0);
    expect(result.components.validation).toBe(0.5);
  });

  it("saturates provenance depth beyond the threshold", () => {
    const above = scoreConfidence({ ...baseline, provenance_depth: PROVENANCE_SATURATION + 10 });
    const at = scoreConfidence({ ...baseline, provenance_depth: PROVENANCE_SATURATION });
    expect(above.confidence).toEqual(at.confidence);
  });
});

describe("pathConfidence", () => {
  it("returns null for empty paths", () => {
    expect(pathConfidence([])).toBeNull();
  });
  it("returns the weakest link", () => {
    expect(pathConfidence([0.9, 0.4, 0.8])).toBe(0.4);
  });
  it("ignores non-finite entries", () => {
    expect(pathConfidence([0.9, Number.NaN, 0.5])).toBe(0.5);
  });
});
