// phase-durations — what each phase of the pipeline actually costs, measured (#3097).
//
// **An honest ETA needs a duration model, and the ledger held none.**
// `.red/state/castle/history.toonl` records one `duration_s` per terminal
// issue-level event, so the finest answer it can give is "issues like this one
// took ~22 min on this runner" — true, useless to a progress bar, and unable to
// say anything at all about a Worker three minutes into `validating`. This lane
// records the missing grain: one row per phase a Worker LEAVES, with the seconds
// it spent there.
//
// **A linear extrapolation from the bar is refused, and this file is the
// alternative.** `phase_index / phase_total` moves with the cursor, so an ETA
// derived from it looks precise while being systematically wrong — `coding` and
// `validating` do not cost the same, and no amount of averaging fixes an estimate
// whose only input is a position. Every function here reads measured seconds per
// PHASE NAME and nothing else; none of them takes an index or a total. That is
// structural, not a convention: the signatures cannot express the wrong estimate.
//
// **A phase nobody has measured enough of gets no estimate.** `null` is the
// answer whenever any phase between here and the end is short of samples, because
// an estimate assembled from one observation of `merging` is a number the
// dashboard would print with the same confidence as a well-founded one. Ship no
// ETA rather than that one.
//
// The lane is TOONL under the durable castle state root, beside the ledger it
// refines. Everything except the file IO is pure: the clock is a parameter.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { decode, encode, type JsonValue } from "@reddb-io/toon";

/** The lane's filename, under `.red/state/castle/`. */
export const PHASE_DURATIONS_FILENAME = "phase-durations.toonl";

/**
 * How many observations a phase needs before it may inform an estimate.
 *
 * Three, because two can be a coincidence and one is an anecdote. The whole
 * estimate is refused when any phase ahead is under this — a partial model
 * produces a confident-looking figure assembled from the phases that happened to
 * be cheap to measure.
 */
export const PHASE_DURATION_MIN_SAMPLES = 3;

/**
 * How many recent observations of one phase inform its median.
 *
 * Bounded so a model built over months tracks how the pipeline behaves NOW: a
 * gate that got twice as slow last week is the fact an operator is asking about,
 * and an unbounded mean would take months to admit it.
 */
export const PHASE_DURATION_SAMPLE_WINDOW = 40;

/** How many rows the lane keeps before the oldest are dropped. */
export const PHASE_DURATIONS_MAX_RECORDS = 5000;

/** One phase, left, with what it cost. */
export interface PhaseDurationRecord {
  readonly ts: string;
  readonly epoch: number;
  readonly worker: string;
  readonly issue: number;
  readonly runner: string;
  readonly phase: string;
  readonly duration_s: number;
}

const PHASE_DURATION_FIELDS = ["ts", "epoch", "worker", "issue", "runner", "phase", "duration_s"] as const;
const PHASE_DURATION_HEADER_RE = /^\[(\d+)\]\{ts,epoch,worker,issue,runner,phase,duration_s\}:$/;

/** The durable lane for one checkout. PURE. */
export function phaseDurationsPath(redRoot: string): string {
  return join(redRoot, "state", "castle", PHASE_DURATIONS_FILENAME);
}

/** What the Worker knows about itself when a phase ends. */
export interface PhaseDurationIdentity {
  readonly worker: string;
  readonly issue: number;
  readonly runner: string;
}

/** One row, built from a completed phase and the clock that closed it. PURE. */
export function buildPhaseDurationRecord(
  identity: PhaseDurationIdentity,
  phase: string,
  durationSeconds: number,
  clock: { readonly ts: string; readonly epoch: number },
): PhaseDurationRecord {
  return {
    ts: clock.ts,
    epoch: clock.epoch,
    worker: identity.worker,
    issue: identity.issue,
    runner: identity.runner,
    phase,
    duration_s: Math.max(0, Math.round(durationSeconds)),
  };
}

/**
 * Which phase a Worker is in, and since when.
 *
 * Held rather than persisted: the instant a phase began is knowable only by
 * something that watched it begin, and a Worker that restarted mid-issue honestly
 * does not know. It re-learns on its next transition and publishes no estimate
 * until then — the alternative is inventing a start time and reporting the
 * invention as a measurement.
 */
export interface PhaseWatch {
  readonly phase: string;
  readonly since_epoch: number;
}

export interface PhaseAdvance {
  readonly watch: PhaseWatch;
  /** The phase that just ended, when one did. */
  readonly completed: { readonly phase: string; readonly duration_s: number } | null;
}

/**
 * Move the watch to `phase`, closing the previous one if it changed. PURE.
 *
 * Idempotent on a repeated phase, which matters because every writer of
 * `current.phase` re-stamps it on every beat: `coding` is written on each stream
 * event, and a watch that reset on each of those would measure the interval
 * between two log lines and call it a phase.
 */
export function advancePhaseWatch(watch: PhaseWatch | null, phase: string, nowEpoch: number): PhaseAdvance {
  if (phase === "") return { watch: watch ?? { phase, since_epoch: nowEpoch }, completed: null };
  if (watch == null || watch.phase === "") return { watch: { phase, since_epoch: nowEpoch }, completed: null };
  if (watch.phase === phase) return { watch, completed: null };
  return {
    watch: { phase, since_epoch: nowEpoch },
    completed: { phase: watch.phase, duration_s: Math.max(0, nowEpoch - watch.since_epoch) },
  };
}

/** What the lane says one phase costs. */
export interface PhaseDurationSummary {
  /** The median of the sampled observations, in seconds. */
  readonly median_s: number;
  /** How many observations informed it — the whole basis for trusting the median. */
  readonly samples: number;
}

export type PhaseDurationStats = ReadonlyMap<string, PhaseDurationSummary>;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/**
 * What each phase costs, per the lane. PURE.
 *
 * **The median, never the mean.** One `validating` that sat an hour on a host-wide
 * gate lock drags a mean into fiction and moves a median by one position; a
 * pipeline's cost distribution has exactly that tail.
 *
 * **A runner's own history wins when it has one.** `codex` and `claude` do not
 * cost the same on the same phase, so a runner with enough samples is summarized
 * alone. Below the threshold it falls back to every runner's rows rather than
 * refusing: a broad answer beats no answer, and the sample count travels with the
 * summary so a caller can still decide.
 */
export function summarizePhaseDurations(
  records: readonly PhaseDurationRecord[],
  options: { readonly runner?: string; readonly minSamples?: number; readonly window?: number } = {},
): PhaseDurationStats {
  const minSamples = options.minSamples ?? PHASE_DURATION_MIN_SAMPLES;
  const window = options.window ?? PHASE_DURATION_SAMPLE_WINDOW;
  const byPhase = new Map<string, PhaseDurationRecord[]>();
  for (const record of records) {
    if (record.phase === "") continue;
    const bucket = byPhase.get(record.phase);
    if (bucket) bucket.push(record);
    else byPhase.set(record.phase, [record]);
  }

  const stats = new Map<string, PhaseDurationSummary>();
  for (const [phase, all] of byPhase) {
    const scoped = options.runner ? all.filter((record) => record.runner === options.runner) : all;
    const chosen = scoped.length >= minSamples ? scoped : all;
    const sampled = chosen.slice(Math.max(0, chosen.length - window));
    if (sampled.length === 0) continue;
    stats.set(phase, { median_s: median(sampled.map((record) => record.duration_s)), samples: sampled.length });
  }
  return stats;
}

/**
 * Seconds the work is expected to take from the START of `phase`, or `null`. PURE.
 *
 * The sum of the measured median of `phase` and of every phase after it in
 * `order`. `order` carries only the phases that COST something — the terminal
 * `done` is a state, not a span, and including it would add the median of a phase
 * nothing is ever observed leaving.
 *
 * Note what this function cannot see: there is no index, no total and no position
 * in its signature. An extrapolation from the progress bar is not merely refused
 * here, it is inexpressible.
 */
export function estimatePhaseEtaSeconds(input: {
  readonly stats: PhaseDurationStats;
  readonly order: readonly string[];
  readonly phase: string;
  readonly minSamples?: number;
}): number | null {
  const minSamples = input.minSamples ?? PHASE_DURATION_MIN_SAMPLES;
  const from = input.order.indexOf(input.phase);
  if (from < 0) return null;
  let total = 0;
  for (const phase of input.order.slice(from)) {
    const summary = input.stats.get(phase);
    // One unmeasured phase ahead refuses the WHOLE estimate. Summing the ones we
    // do know would publish a floor as if it were a forecast, and a dashboard
    // that lies about one number loses its reader for all of them.
    if (summary == null || summary.samples < minSamples) return null;
    total += summary.median_s;
  }
  return total;
}

/**
 * What is left of an estimate, given how long the phase has already run. PURE.
 *
 * A countdown of a measured estimate, not a re-derivation: the model is consulted
 * once, when the phase is entered, and time simply passes against it. Floored at
 * zero — an exhausted estimate says it has nothing left to promise, which is a
 * fact, where a negative number would be an arithmetic artefact.
 */
export function remainingEtaSeconds(estimateAtEntry: number | null, phaseElapsedSeconds: number): number | null {
  if (estimateAtEntry == null) return null;
  return Math.max(0, Math.round(estimateAtEntry - phaseElapsedSeconds));
}

/** The lane, rendered. TOON encoder — never `JSON.stringify` into a `.toonl`. PURE. */
export function renderPhaseDurationsToonl(records: readonly PhaseDurationRecord[]): string {
  if (records.length === 0) return `[0]{${PHASE_DURATION_FIELDS.join(",")}}:\n`;
  return encode(records as unknown as JsonValue);
}

function normalizeRecord(raw: unknown): PhaseDurationRecord | null {
  if (raw === null || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.ts !== "string") return null;
  if (typeof rec.phase !== "string" || rec.phase === "") return null;
  const epoch = Number(rec.epoch);
  const duration = Number(rec.duration_s);
  if (!Number.isFinite(epoch) || !Number.isFinite(duration)) return null;
  const issue = Number(rec.issue ?? 0);
  return {
    ts: rec.ts,
    epoch,
    worker: typeof rec.worker === "string" ? rec.worker : "",
    issue: Number.isFinite(issue) ? issue : 0,
    runner: typeof rec.runner === "string" ? rec.runner : "",
    phase: rec.phase,
    duration_s: duration,
  };
}

/** The lane, parsed. A truncated tail row is dropped, never fatal. PURE. */
export function parsePhaseDurationsToonl(text: string): PhaseDurationRecord[] {
  const lines = text.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.trim().length > 0);
  if (headerIndex < 0) return [];
  if (!PHASE_DURATION_HEADER_RE.test(lines[headerIndex]!.trim())) return [];
  const out: PhaseDurationRecord[] = [];
  for (const raw of lines.slice(headerIndex + 1)) {
    if (raw.trim().length === 0) continue;
    try {
      const value = decode(`[1]{${PHASE_DURATION_FIELDS.join(",")}}:\n${raw}\n`);
      const record = normalizeRecord(Array.isArray(value) ? value[0] : value);
      if (record) out.push(record);
    } catch {
      continue;
    }
  }
  return out;
}

/** Thin injectable IO so a caller (and a test) can swap the filesystem. */
export interface PhaseDurationsIO {
  read(path: string): Promise<string | null>;
  write(path: string, text: string): Promise<void>;
}

export const defaultPhaseDurationsIO: PhaseDurationsIO = {
  async read(path) {
    try {
      return await readFile(path, "utf8");
    } catch {
      return null;
    }
  },
  async write(path, text) {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, text, "utf8");
    await rename(tmp, path);
  },
};

export async function readPhaseDurations(
  path: string,
  io: PhaseDurationsIO = defaultPhaseDurationsIO,
): Promise<PhaseDurationRecord[]> {
  const text = await io.read(path);
  return text == null ? [] : parsePhaseDurationsToonl(text);
}

/**
 * Append one measured phase, capped at {@link PHASE_DURATIONS_MAX_RECORDS}.
 *
 * Read-modify-write rather than a raw append, because the TOONL header states the
 * row count: a row appended past a stale count is a lane that decodes to fewer
 * rows than it holds. Phase transitions happen a handful of times per issue, so
 * the cost is paid once per phase and never on a beat.
 */
export async function appendPhaseDuration(
  path: string,
  record: PhaseDurationRecord,
  io: PhaseDurationsIO = defaultPhaseDurationsIO,
): Promise<PhaseDurationRecord[]> {
  const existing = await readPhaseDurations(path, io);
  const all = [...existing, record];
  const kept = all.slice(Math.max(0, all.length - PHASE_DURATIONS_MAX_RECORDS));
  await io.write(path, renderPhaseDurationsToonl(kept));
  return kept;
}

/** One Worker's live view of the model: it measures as it goes, and it estimates. */
export interface PhaseDurationTracker {
  /** Note the phase this Worker is in now. Records the previous one if it ended. */
  observe(input: {
    readonly phase: string;
    readonly identity: PhaseDurationIdentity;
    readonly nowEpoch: number;
    readonly nowIso: string;
  }): Promise<void>;
  /** Seconds of work expected to remain, or `null` when nothing may be claimed. */
  etaSeconds(nowEpoch: number): number | null;
}

/**
 * The measuring and the estimating halves of the model, as one object.
 *
 * They belong together because they are the same loop: every phase this Worker
 * leaves makes the next estimate better, and the estimate is only ever consulted
 * at a boundary the measurement just wrote.
 *
 * **No estimate is published before a transition is WITNESSED.** A Worker that
 * attached mid-phase — a restarted process, a first observation — knows the phase
 * but not when it began, and an estimate counted from "now" would silently add
 * the part already spent. It stays `null` until this tracker has seen a phase
 * start with its own eyes.
 */
export function createPhaseDurationTracker(options: {
  readonly path: string;
  /** The phases that cost something, in order. Vocabulary belongs to the caller. */
  readonly order: readonly string[];
  readonly io?: PhaseDurationsIO;
  readonly minSamples?: number;
}): PhaseDurationTracker {
  const io = options.io ?? defaultPhaseDurationsIO;
  let records: PhaseDurationRecord[] | null = null;
  let watch: PhaseWatch | null = null;
  let estimateAtEntry: number | null = null;
  let witnessed = false;

  return {
    async observe({ phase, identity, nowEpoch, nowIso }) {
      if (records == null) records = await readPhaseDurations(options.path, io);
      const advance = advancePhaseWatch(watch, phase, nowEpoch);
      if (advance.watch === watch) return;
      if (advance.completed != null) {
        witnessed = true;
        records = await appendPhaseDuration(
          options.path,
          buildPhaseDurationRecord(identity, advance.completed.phase, advance.completed.duration_s, {
            ts: nowIso,
            epoch: nowEpoch,
          }),
          io,
        );
      }
      watch = advance.watch;
      estimateAtEntry = witnessed
        ? estimatePhaseEtaSeconds({
          stats: summarizePhaseDurations(records, {
            runner: identity.runner,
            ...(options.minSamples == null ? {} : { minSamples: options.minSamples }),
          }),
          order: options.order,
          phase: watch.phase,
          ...(options.minSamples == null ? {} : { minSamples: options.minSamples }),
        })
        : null;
    },
    etaSeconds(nowEpoch) {
      if (watch == null) return null;
      return remainingEtaSeconds(estimateAtEntry, nowEpoch - watch.since_epoch);
    },
  };
}
