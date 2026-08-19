/**
 * Confidence-scoring composer (issue #167, parent #165).
 *
 * Pure function — no I/O. Given a small bag of signals about a memory node,
 * produces a deterministic confidence score in [0, 1] plus a component
 * breakdown so callers can explain *why* a node is trusted or distrusted.
 *
 * The four signals are intentionally normalized at the boundary so the
 * composer stays decoupled from the live graph/store and is trivial to
 * table-test.
 */

export type SupersessionStatus = "active" | "superseded" | "superseding";

export interface ConfidenceSignals {
  /**
   * Provenance depth: how many independent provenance hops back the claim
   * can be traced (0 = ungrounded, 1 = direct source, 2+ = multiple sources).
   * Clamped and saturated by `PROVENANCE_SATURATION`.
   */
  provenance_depth: number;
  /** Recency factor in [0, 1] — fresh = 1, stale = 0. Callers compute the decay. */
  recency: number;
  /** Supersession state of the node in its chain. */
  supersession_status: SupersessionStatus;
  /**
   * Validation signal in [-1, 1] — net CONFIRMS minus CONTRADICTS edges,
   * normalized. 0 = neutral, +1 = strongly confirmed, -1 = strongly contradicted.
   */
  validation_signal: number;
}

export interface ConfidenceBreakdown {
  /** Final confidence in [0, 1]. */
  confidence: number;
  /** Per-signal normalized components in [0, 1]. */
  components: {
    provenance: number;
    recency: number;
    supersession: number;
    validation: number;
  };
  /** Policy metadata so callers can render the formula in an overlay. */
  policy: {
    weights: {
      provenance: number;
      recency: number;
      supersession: number;
      validation: number;
    };
    provenance_saturation: number;
  };
}

export const CONFIDENCE_WEIGHTS = {
  provenance: 0.3,
  recency: 0.25,
  supersession: 0.25,
  validation: 0.2,
} as const;

/** Provenance depth saturates here — three independent sources buy you full marks. */
export const PROVENANCE_SATURATION = 3;

const SUPERSESSION_COMPONENT: Record<SupersessionStatus, number> = {
  active: 1,
  superseding: 1,
  superseded: 0.3,
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function provenanceComponent(depth: number): number {
  if (!Number.isFinite(depth) || depth <= 0) return 0;
  return Math.min(1, depth / PROVENANCE_SATURATION);
}

function validationComponent(signal: number): number {
  if (!Number.isFinite(signal)) return 0.5;
  const clamped = Math.max(-1, Math.min(1, signal));
  return (clamped + 1) / 2;
}

/**
 * Compose a confidence breakdown from the four signals. Pure: same input →
 * same output, no clock, no store, no globals.
 */
export function scoreConfidence(signals: ConfidenceSignals): ConfidenceBreakdown {
  const components = {
    provenance: provenanceComponent(signals.provenance_depth),
    recency: clamp01(signals.recency),
    supersession: SUPERSESSION_COMPONENT[signals.supersession_status] ?? 0,
    validation: validationComponent(signals.validation_signal),
  };
  const confidence = clamp01(
    components.provenance * CONFIDENCE_WEIGHTS.provenance +
      components.recency * CONFIDENCE_WEIGHTS.recency +
      components.supersession * CONFIDENCE_WEIGHTS.supersession +
      components.validation * CONFIDENCE_WEIGHTS.validation,
  );
  return {
    confidence: round3(confidence),
    components: {
      provenance: round3(components.provenance),
      recency: round3(components.recency),
      supersession: round3(components.supersession),
      validation: round3(components.validation),
    },
    policy: {
      weights: { ...CONFIDENCE_WEIGHTS },
      provenance_saturation: PROVENANCE_SATURATION,
    },
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Path-level confidence: weakest link. Returns null for empty input. */
export function pathConfidence(nodeConfidences: readonly number[]): number | null {
  if (nodeConfidences.length === 0) return null;
  let min = Number.POSITIVE_INFINITY;
  for (const c of nodeConfidences) {
    if (!Number.isFinite(c)) continue;
    if (c < min) min = c;
  }
  return Number.isFinite(min) ? round3(clamp01(min)) : null;
}
