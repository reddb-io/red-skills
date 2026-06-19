/**
 * proof-by-drain.ts — the canary→stable promotion gate, read from the AFK
 * history telemetry (ADR 0058).
 *
 * A release channel is promoted by a *tag move* (see the ADR / the
 * `afk-promote-channel.sh` script). Whether that move is *earned* is decided
 * here: the canary must demonstrate a healthy drain — enough successful merges,
 * observed over a long enough window, with a low enough failure ratio — before
 * the floating `canary` tag is moved onto `stable`.
 *
 * The metrics come straight from the `afk-history.jsonl` ledger
 * ({@link HistoryRecord} in `history.ts`): `done` events carrying a `merge_sha`
 * are landed work (the drain), while `blocked`/`exhausted` are the failure lane.
 * Thresholds here are the *initial* bar from ADR 0058; tuning them is
 * operational and out of scope for this slice (PRD #614).
 */

import { type HistoryRecord, parseHistoryLines } from "./history.js";

/** The initial promotion bar from ADR 0058. Tuning is operational (out of scope). */
export interface PromotionBar {
  /** Minimum landed canary merges (the drain proof). */
  minMerges: number;
  /** Minimum span, in hours, between the earliest and latest counted terminal event. */
  minWindowHours: number;
  /** Ceiling on (blocked + exhausted) / terminal. */
  maxFailureRatio: number;
}

export const DEFAULT_PROMOTION_BAR: PromotionBar = {
  minMerges: 20,
  minWindowHours: 24,
  maxFailureRatio: 0.1,
};

export interface DrainMetrics {
  /** `done` events that carry a `merge_sha` — actually-landed work. */
  merges: number;
  /** All `done` events (some `done` may be salvage/no-merge terminals). */
  done: number;
  blocked: number;
  exhausted: number;
  /** done + blocked + exhausted. */
  terminal: number;
  /** (blocked + exhausted) / terminal, or 0 when there are no terminal events. */
  failureRatio: number;
  /** (latest − earliest counted record epoch) / 3600. */
  windowHours: number;
  /** Records counted (after the optional `sinceEpoch` filter). */
  records: number;
}

const TERMINAL_EVENTS = new Set(["done", "blocked", "exhausted"]);

/**
 * Aggregate drain metrics from ledger records. When `sinceEpoch` is given, only
 * records at or after it are counted — the caller passes the epoch the current
 * canary build was cut so the gate measures *this* canary's drain.
 */
export function computeDrainMetrics(
  records: ReadonlyArray<HistoryRecord>,
  sinceEpoch = 0,
): DrainMetrics {
  let merges = 0;
  let done = 0;
  let blocked = 0;
  let exhausted = 0;
  let minEpoch = Number.POSITIVE_INFINITY;
  let maxEpoch = Number.NEGATIVE_INFINITY;
  let counted = 0;

  for (const r of records) {
    if (r.epoch < sinceEpoch) continue;
    if (!TERMINAL_EVENTS.has(r.event)) continue;
    counted += 1;
    if (r.epoch < minEpoch) minEpoch = r.epoch;
    if (r.epoch > maxEpoch) maxEpoch = r.epoch;
    if (r.event === "done") {
      done += 1;
      if (r.merge_sha) merges += 1;
    } else if (r.event === "blocked") {
      blocked += 1;
    } else if (r.event === "exhausted") {
      exhausted += 1;
    }
  }

  const terminal = done + blocked + exhausted;
  const failureRatio = terminal === 0 ? 0 : (blocked + exhausted) / terminal;
  const windowHours = counted === 0 ? 0 : (maxEpoch - minEpoch) / 3600;

  return { merges, done, blocked, exhausted, terminal, failureRatio, windowHours, records: counted };
}

export interface PromotionVerdict {
  /** True when every dimension of the bar is cleared. */
  promotable: boolean;
  /** One human-readable line per unmet dimension; empty when promotable. */
  reasons: string[];
  metrics: DrainMetrics;
}

/** Evaluate metrics against the bar, collecting a reason for every unmet gate. */
export function evaluatePromotion(
  metrics: DrainMetrics,
  bar: PromotionBar = DEFAULT_PROMOTION_BAR,
): PromotionVerdict {
  const reasons: string[] = [];
  if (metrics.merges < bar.minMerges) {
    reasons.push(`merges ${metrics.merges} < required ${bar.minMerges}`);
  }
  if (metrics.windowHours < bar.minWindowHours) {
    reasons.push(
      `observed window ${metrics.windowHours.toFixed(1)}h < required ${bar.minWindowHours}h`,
    );
  }
  if (metrics.failureRatio > bar.maxFailureRatio) {
    reasons.push(
      `failure ratio ${metrics.failureRatio.toFixed(2)} > ceiling ${bar.maxFailureRatio}`,
    );
  }
  return { promotable: reasons.length === 0, reasons, metrics };
}

/** Minimal injectable read surface (a subset of HistoryIO) for the ledger. */
export interface DrainReadIO {
  read(path: string): Promise<string | null>;
}

/**
 * Read the ledger and compute drain metrics. A missing/empty ledger yields the
 * zero metrics (never throws on absence — the gate just reads as "not yet").
 */
export async function readDrainMetrics(
  path: string,
  io: DrainReadIO,
  sinceEpoch = 0,
): Promise<DrainMetrics> {
  const text = await io.read(path);
  if (!text) return computeDrainMetrics([], sinceEpoch);
  return computeDrainMetrics(parseHistoryLines(text), sinceEpoch);
}
