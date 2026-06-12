// Cross-host stale-claim recovery: the PURE classification function (claim
// record + clock → fresh | stale) that drives the claim reconciler's injected
// `isStale` predicate (core/claim.ts, ADR 0066, issue #627, PRD #614).
//
// The atomic GitHub-native claim substrate already arbitrates a single winner
// across hosts via server-ordered claim comments, and leaves liveness as a pure
// injection point (`reconcileClaim(records, self, { isStale })`). This module is
// that injected fact: it decides whether a claim record's owner has stopped
// refreshing long enough to be presumed dead — WITHOUT any I/O. The reconciler
// then drops stale contenders before the first-claim-wins ordering, so a claim
// held by a worker that died on another machine is released by ANY other
// worker's sweep, no human hunting required.
//
// A live worker keeps its claim fresh by re-posting its claim marker on a
// cadence (the substrate already orders by EARLIEST claim id and reads staleness
// off the LATEST marker, so a refresh never improves the worker's queue position
// but does reset its liveness clock). The staleness WINDOW is deliberately a
// generous multiple of that refresh cadence — `cadence × (tolerance + 1)` — so a
// live-but-slow worker that merely missed a few refreshes is NEVER robbed; only a
// worker silent past the whole window is reclaimed.
//
// Everything here is pure with an injected clock (`nowS`, epoch seconds), so the
// classification is unit-testable without a real clock or network.

import type { ClaimRecord } from "./claim.js";

/** Default seconds between a live worker's claim refreshes. Coarser than the
 * heartbeat (60s) so refresh re-posts do not flood the issue thread, yet far
 * tighter than any realistic attempt duration. */
export const DEFAULT_CLAIM_REFRESH_S = 300;

/** Default count of consecutive missed refreshes tolerated before a claim is
 * presumed stale. The window then spans `cadence × (tolerance + 1)` so a worker
 * can miss this many refreshes (transient gh failure, GC pause, slow step) and
 * still hold its claim. */
export const DEFAULT_CLAIM_STALE_TOLERANCE = 3;

/** Staleness policy: the refresh cadence a live worker is expected to keep, and
 * how many consecutive missed refreshes are tolerated before the claim is stale. */
export interface ClaimStalenessConfig {
  /** Seconds between a live worker's claim refreshes. */
  refreshCadenceS: number;
  /** Consecutive missed refreshes tolerated before the claim is presumed stale. */
  tolerance: number;
}

export const DEFAULT_CLAIM_STALENESS: ClaimStalenessConfig = {
  refreshCadenceS: DEFAULT_CLAIM_REFRESH_S,
  tolerance: DEFAULT_CLAIM_STALE_TOLERANCE,
};

export type ClaimFreshness = "fresh" | "stale";

/**
 * The staleness window in seconds — the maximum age a claim record may reach
 * before its owner is presumed dead. `cadence × (tolerance + 1)`: at cadence the
 * worker refreshes once, so toleration of N missed refreshes means surviving up
 * to (N+1) cadences of silence. Comfortably exceeds the refresh cadence by
 * construction, which is what keeps a live-but-slow worker from being robbed.
 */
export function staleWindowS(config: ClaimStalenessConfig = DEFAULT_CLAIM_STALENESS): number {
  return config.refreshCadenceS * (config.tolerance + 1);
}

/** Parse a claim record's ISO timestamp to epoch seconds, or null when absent /
 * unparseable. A null age means "unknown" and is treated as FRESH downstream —
 * the conservative choice that never robs a claim whose age we cannot establish. */
function recordEpochS(record: ClaimRecord): number | null {
  if (!record.createdAt) return null;
  const ms = Date.parse(record.createdAt);
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / 1000);
}

/**
 * Classify a single claim record against an injected clock. PURE — the entire
 * point of issue #627's testable acceptance criterion.
 *
 *   - No / unparseable timestamp        → fresh (never rob an unknown-age claim)
 *   - timestamp in the future (skew)    → fresh
 *   - age ≤ staleWindowS                → fresh
 *   - age >  staleWindowS               → stale (owner presumed dead, recoverable)
 *
 * @param nowS injected current epoch seconds.
 */
export function classifyClaim(
  record: ClaimRecord,
  nowS: number,
  config: ClaimStalenessConfig = DEFAULT_CLAIM_STALENESS,
): ClaimFreshness {
  const ts = recordEpochS(record);
  if (ts === null) return "fresh";
  const ageS = nowS - ts;
  if (ageS <= staleWindowS(config)) return "fresh";
  return "stale";
}

/**
 * Build the `isStale` predicate the claim reconciler injects. Binds the injected
 * clock + policy once and returns `record → boolean`, returning true only for a
 * record classified `stale`. This is the single seam between the pure classifier
 * and `reconcileClaim(records, self, { isStale })`.
 */
export function makeStaleClaimPredicate(
  nowS: number,
  config: ClaimStalenessConfig = DEFAULT_CLAIM_STALENESS,
): (record: ClaimRecord) => boolean {
  return (record) => classifyClaim(record, nowS, config) === "stale";
}

// ---------- cross-host stale-claim sweep (pure planner) ----------
//
// The claim-time `isStale` injection only re-examines a claim when a worker
// SELECTS the issue to claim it. A worker that died on another host leaves its
// issue projected as `running` (out of the ready pool), so no other worker ever
// re-selects it — the claim would strand forever. This planner closes that gap:
// it sweeps the currently-claimed issues directly, classifies each issue's claim,
// and plans a release for any issue held ONLY by a stale (dead-owner) claim. The
// boot orchestrator applies the plan — restore `ready-for-agent`, strip
// `running`, post one audit comment — returning the issue to the executable pool.

/** The folded claim state of a single issue. */
export interface IssueClaimState {
  /** The live winning worker — the earliest non-conceded, non-stale claim — or
   * null when no live claim holds the issue. */
  liveOwner: string | null;
  /** Active (non-conceded) claimants whose LATEST marker classified stale. */
  staleOwners: string[];
}

/**
 * Fold an issue's claim records into its live owner + stale owners (pure). A
 * worker's latest marker decides whether it still contends (a `concede` withdraws
 * it); its earliest `claim` id is its order key. The live owner is the lowest
 * order key among contenders the predicate deems fresh; stale contenders are
 * reported separately so the sweep can audit exactly who it released.
 */
export function classifyIssueClaims(
  records: readonly ClaimRecord[],
  isStale: (record: ClaimRecord) => boolean,
): IssueClaimState {
  interface Fold {
    earliestClaimId: number | null;
    latestId: number;
    latestKind: "claim" | "concede";
    latestRecord: ClaimRecord;
  }
  const folds = new Map<string, Fold>();
  for (const r of records) {
    if (!Number.isFinite(r.commentId) || r.worker === "") continue;
    const f = folds.get(r.worker);
    if (f === undefined) {
      folds.set(r.worker, {
        earliestClaimId: r.kind === "claim" ? r.commentId : null,
        latestId: r.commentId,
        latestKind: r.kind,
        latestRecord: r,
      });
      continue;
    }
    if (r.kind === "claim" && (f.earliestClaimId === null || r.commentId < f.earliestClaimId)) {
      f.earliestClaimId = r.commentId;
    }
    if (r.commentId >= f.latestId) {
      f.latestId = r.commentId;
      f.latestKind = r.kind;
      f.latestRecord = r;
    }
  }

  let liveOwner: string | null = null;
  let liveOwnerId = Infinity;
  const staleOwners: string[] = [];
  for (const [worker, f] of folds) {
    if (f.latestKind === "concede") continue; // withdrew
    if (f.earliestClaimId === null) continue; // only ever conceded — not a claim
    if (isStale(f.latestRecord)) {
      staleOwners.push(worker);
      continue;
    }
    if (f.earliestClaimId < liveOwnerId) {
      liveOwnerId = f.earliestClaimId;
      liveOwner = worker;
    }
  }
  staleOwners.sort();
  return { liveOwner, staleOwners };
}

/** One claimed issue handed to the sweep: the issue number + its parsed claim
 * marker records (from `parseClaimRecords`). */
export interface ClaimedIssue {
  issue: number;
  records: readonly ClaimRecord[];
}

/** A planned release: the issue to return to the executable pool + the stale
 * owners whose dead claim it recovered (for the audit comment). */
export interface StaleClaimRelease {
  issue: number;
  staleOwners: string[];
}

/** Render the single audit comment the boot sweep posts when it releases an
 * issue whose owner died on another host (#627) — the visible record that the
 * issue returned to the executable pool. */
export function renderStaleClaimSweepAudit(staleOwners: readonly string[]): string {
  const who = staleOwners.map((w) => `\`${w}\``).join(", ");
  return (
    `🤖 AFK cross-host stale-claim sweep: released this issue back to \`ready-for-agent\` — ` +
    `${staleOwners.length === 1 ? "the claim" : "the claims"} held by ${who} stopped refreshing ` +
    `past the staleness window (owner presumed dead on another host).`
  );
}

/**
 * Plan which claimed issues to release back to the executable pool (pure). An
 * issue is released ONLY when it has at least one stale claim AND no LIVE claim
 * holds it — so a live-but-slow worker (its claim still within the window) is
 * never robbed, and an issue with a live contender is left to that contender.
 * The boot orchestrator applies each release: restore `ready-for-agent`, strip
 * `running`, and post one audit comment naming the recovered stale owners.
 */
export function planStaleClaimSweep(
  claimed: readonly ClaimedIssue[],
  nowS: number,
  config: ClaimStalenessConfig = DEFAULT_CLAIM_STALENESS,
): StaleClaimRelease[] {
  const isStale = makeStaleClaimPredicate(nowS, config);
  const releases: StaleClaimRelease[] = [];
  for (const c of claimed) {
    const state = classifyIssueClaims(c.records, isStale);
    if (state.liveOwner === null && state.staleOwners.length > 0) {
      releases.push({ issue: c.issue, staleOwners: state.staleOwners });
    }
  }
  return releases;
}

const POSITIVE_INT_RE = /^[0-9]+$/;

function resolvePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw !== undefined && POSITIVE_INT_RE.test(raw)) {
    const n = Number(raw);
    if (n > 0) return n;
  }
  return fallback;
}

function resolveNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw !== undefined && POSITIVE_INT_RE.test(raw)) {
    return Number(raw);
  }
  return fallback;
}

/**
 * Resolve the staleness policy from the environment. `RED_AFK_CLAIM_REFRESH_S`
 * (positive int, default 300) and `RED_AFK_CLAIM_STALE_TOLERANCE` (non-negative
 * int, default 3). A missing / non-numeric / non-positive cadence falls back to
 * the default so an operator typo can never collapse the window to zero and rob
 * live claims; tolerance accepts 0 (window = exactly one cadence).
 */
export function resolveClaimStalenessConfig(
  env: Record<string, string | undefined> = process.env,
): ClaimStalenessConfig {
  return {
    refreshCadenceS: resolvePositiveInt(env.RED_AFK_CLAIM_REFRESH_S, DEFAULT_CLAIM_REFRESH_S),
    tolerance: resolveNonNegativeInt(env.RED_AFK_CLAIM_STALE_TOLERANCE, DEFAULT_CLAIM_STALE_TOLERANCE),
  };
}
