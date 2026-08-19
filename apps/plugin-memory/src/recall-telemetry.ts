/**
 * Recall telemetry (PRD #820, issue #828).
 *
 * Rolls up `memory.recall.observed` events from the analytics hypertable into a
 * report of real-run recall quality — recall hit-rate, gold-in-pack proxy, and
 * tokens saved. This is deliberately *distinct from the synthetic retrieval
 * benchmark* (`bench-eval.ts` / `memory bench`): the benchmark measures
 * substrate quality on a curated gold corpus, while this measures what actually
 * happened in production agent runs. ADR 0037 mandates pairing every token
 * number with an accuracy signal, so token savings are reported next to the
 * hit-rate / gold-in-pack proxy, never alone.
 */
import type { MemoryStore } from "./graph-store.js";
import type { ContextPack } from "./context-pack.js";
import {
  readMemoryEvents,
  type MemoryEvent,
  type MemoryEventReadOptions,
  type RecallObservationInput,
  type RecallObservationPayload,
} from "./memory-events.js";

/** Default telemetry window: last 7 days of recall observations. */
export const DEFAULT_RECALL_TELEMETRY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Rough chars-per-token estimate used when token counts are not provided. */
const CHARS_PER_TOKEN = 4;

export interface RecallTelemetryReport {
  schema_version: "memory.recall-telemetry.v1";
  /** Marks this as real-run telemetry, not the synthetic benchmark. */
  source: "real-runs";
  read_only: true;
  window_ms: number;
  observation_count: number;
  recall_total: number;
  recall_hits: number;
  recall_hit_rate: number;
  gold_in_pack_count: number;
  gold_in_pack_rate: number;
  tokens_baseline_total: number;
  tokens_compressed_total: number;
  tokens_saved_total: number;
  tokens_saved_mean: number;
  savings_ratio: number;
  surfaces: string[];
}

const estimateTokens = (chars: number): number =>
  Math.max(0, Math.ceil(chars / CHARS_PER_TOKEN));

/**
 * Derive a `RecallObservationInput` from a built context pack. The pack is a
 * real recall surface, so this is the natural emission point for production
 * telemetry. `tokens_baseline` approximates the cost of delivering every
 * recalled candidate (including the ones budgeting dropped) at the average
 * delivered size; `tokens_compressed` is what the pack actually spent.
 */
export function recallObservationFromContextPack(
  pack: ContextPack,
  opts: { surface?: string; query?: string; sessionId?: string; runner?: string } = {},
): RecallObservationInput {
  const returnedCount = pack.entries.length;
  const candidateCount = returnedCount + pack.omittedEntries;
  const avgEntryChars = returnedCount > 0 ? pack.usedChars / returnedCount : 0;
  const baselineChars = pack.usedChars + pack.omittedEntries * avgEntryChars;
  const query = opts.query ?? pack.goal;
  return {
    surface: opts.surface ?? "context-pack",
    ...(query ? { query } : {}),
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    ...(opts.runner ? { runner: opts.runner } : {}),
    candidateCount,
    returnedCount,
    hitCount: returnedCount,
    // Proxy: the highest-value (pinned/core) fact survived budgeting, or nothing
    // valuable was dropped at all.
    goldInPackProxy: pack.coreContext.length > 0 || (returnedCount > 0 && pack.omittedEntries === 0),
    tokensBaseline: estimateTokens(baselineChars),
    tokensCompressed: estimateTokens(pack.usedChars),
  };
}

/** Roll up `memory.recall.observed` events into the telemetry report. */
export function deriveRecallTelemetry(
  events: readonly MemoryEvent[],
  opts: { windowMs?: number } = {},
): RecallTelemetryReport {
  const windowMs =
    opts.windowMs == null ? DEFAULT_RECALL_TELEMETRY_WINDOW_MS : opts.windowMs;
  const observations = events
    .filter((event): event is MemoryEvent & { payload: RecallObservationPayload } =>
      event.kind === "memory.recall.observed",
    )
    .map((event) => event.payload);

  let recallTotal = 0;
  let recallHits = 0;
  let goldInPack = 0;
  let tokensBaseline = 0;
  let tokensCompressed = 0;
  let tokensSaved = 0;
  const surfaces = new Set<string>();

  for (const payload of observations) {
    recallTotal++;
    if (payload.hit) recallHits++;
    if (payload.gold_in_pack_proxy) goldInPack++;
    tokensBaseline += payload.tokens_baseline;
    tokensCompressed += payload.tokens_compressed;
    tokensSaved += payload.tokens_saved;
    surfaces.add(payload.surface);
  }

  return {
    schema_version: "memory.recall-telemetry.v1",
    source: "real-runs",
    read_only: true,
    window_ms: Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 0,
    observation_count: observations.length,
    recall_total: recallTotal,
    recall_hits: recallHits,
    recall_hit_rate: recallTotal === 0 ? 0 : recallHits / recallTotal,
    gold_in_pack_count: goldInPack,
    gold_in_pack_rate: recallTotal === 0 ? 0 : goldInPack / recallTotal,
    tokens_baseline_total: tokensBaseline,
    tokens_compressed_total: tokensCompressed,
    tokens_saved_total: tokensSaved,
    tokens_saved_mean: recallTotal === 0 ? 0 : tokensSaved / recallTotal,
    savings_ratio: tokensBaseline === 0 ? 0 : tokensSaved / tokensBaseline,
    surfaces: [...surfaces].sort(),
  };
}

/** Read the hypertable and build the report over the configured window. */
export async function buildRecallTelemetryReport(
  store: MemoryStore,
  opts: { windowMs?: number; now?: MemoryEventReadOptions["now"] } = {},
): Promise<RecallTelemetryReport> {
  const windowMs =
    opts.windowMs == null ? DEFAULT_RECALL_TELEMETRY_WINDOW_MS : opts.windowMs;
  const useWindow = Number.isFinite(windowMs) && windowMs > 0;
  const events = await readMemoryEvents(store, {
    retentionMs: useWindow ? windowMs : undefined,
    now: opts.now,
  });
  return deriveRecallTelemetry(events, { windowMs });
}

const pct = (ratio: number): string => `${(ratio * 100).toFixed(1)}%`;

/** Render the report as markdown, clearly labelled as real-run telemetry. */
export function renderRecallTelemetryReport(report: RecallTelemetryReport): string {
  const lines = [
    "# Recall telemetry (real agent runs)",
    "",
    "Distinct from the synthetic retrieval benchmark (`memory bench`): these",
    "metrics come from `memory.recall.observed` events emitted by real recall",
    "surfaces, not from a curated gold corpus.",
    "",
    `- observations: ${report.observation_count}`,
    `- recall hit-rate: ${pct(report.recall_hit_rate)} (${report.recall_hits}/${report.recall_total})`,
    `- gold-in-pack proxy: ${pct(report.gold_in_pack_rate)} (${report.gold_in_pack_count}/${report.recall_total})`,
    `- tokens saved vs full recall: ${report.tokens_saved_total} (${pct(report.savings_ratio)}; mean ${report.tokens_saved_mean.toFixed(1)}/recall)`,
    `- surfaces: ${report.surfaces.length > 0 ? report.surfaces.join(", ") : "none"}`,
  ];
  return lines.join("\n");
}
