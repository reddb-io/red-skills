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
// A live worker keeps its claim fresh by editing the timestamp on its existing
// claim marker on a shared fleet cadence (the server-order id never changes, so
// a refresh cannot improve queue position and a later concede stays
// authoritative). The staleness WINDOW is deliberately a
// generous multiple of that refresh cadence — `cadence × (tolerance + 1)` — so a
// live-but-slow worker that merely missed a few refreshes is NEVER robbed; only a
// worker silent past the whole window is reclaimed.
//
// Everything here is pure with an injected clock (`nowS`, epoch seconds), so the
// classification is unit-testable without a real clock or network.

import type { ClaimRecord } from "./claim.js";

/** Default seconds between a live worker's claim refreshes. Coarser than the
 * heartbeat (60s) so refresh re-posts do not flood the issue thread, yet far
 * tighter than any realistic attempt duration. Kept at the cache-warm edge of
 * the AFK polling cadence rule, not in the prompt-cache dead zone. */
export const DEFAULT_CLAIM_REFRESH_S = 270;

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

/** Default minimum age before the cross-host sweep may release a claim, even if
 * an operator configured an aggressive stale window. */
export const DEFAULT_CLAIM_REAPER_GRACE_S = DEFAULT_CLAIM_REFRESH_S;

/** Default sliding window in which a commit on the attempt branch proves recent
 * progress and protects the claim from the cross-host stale-claim sweep. */
export const DEFAULT_CLAIM_RECENT_COMMIT_PROTECTION_S = 2700;

export interface ClaimReaperConfig extends ClaimStalenessConfig {
  /** A claim at or below this age is fresh regardless of stale-window settings. */
  claimGraceS: number;
  /** Seconds since the attempt branch's last commit that still counts as active progress. */
  recentCommitProtectionS: number;
}

export const DEFAULT_CLAIM_REAPER: ClaimReaperConfig = {
  ...DEFAULT_CLAIM_STALENESS,
  claimGraceS: DEFAULT_CLAIM_REAPER_GRACE_S,
  recentCommitProtectionS: DEFAULT_CLAIM_RECENT_COMMIT_PROTECTION_S,
};

export type ClaimFreshness = "fresh" | "stale";

/** What a holder's liveness means for the sweep: keep the claim, or reclaim it. */
export type ClaimHolderVerdict = "live" | "evictable";

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
  config: ClaimStalenessConfig | ClaimReaperConfig = DEFAULT_CLAIM_REAPER,
): ClaimFreshness {
  const ts = recordEpochS(record);
  if (ts === null) return "fresh";
  const ageS = nowS - ts;
  if ("claimGraceS" in config && ageS <= config.claimGraceS) return "fresh";
  if (ageS <= staleWindowS(config)) return "fresh";
  return "stale";
}

/**
 * Resolve holder liveness WITHOUT applying remote TTL semantics to a local
 * worker. Same-host process evidence is authoritative: a live pid keeps the claim
 * no matter how old its marker is, and a dead pid makes the claim evictable
 * immediately. Only a REMOTE holder — whose process we cannot inspect — falls
 * back to the shared heartbeat TTL.
 *
 * `localHost` is the local host fingerprint; a worker key is `host:worker_id`.
 */
export function claimHolderVerdict(
  record: ClaimRecord,
  localHost: string,
  localProcessAlive: (worker: string) => boolean,
  nowS: number,
  config: ClaimStalenessConfig | ClaimReaperConfig = DEFAULT_CLAIM_REAPER,
): ClaimHolderVerdict {
  const separator = record.worker.indexOf(":");
  const holderHost = separator < 0 ? "" : record.worker.slice(0, separator);
  if (holderHost === localHost) {
    return localProcessAlive(record.worker) ? "live" : "evictable";
  }
  return classifyClaim(record, nowS, config) === "stale" ? "evictable" : "live";
}

/**
 * Build the `isStale` predicate the claim reconciler injects. Binds the injected
 * clock + policy once and returns `record → boolean`, returning true only for a
 * record classified `stale`. This is the single seam between the pure classifier
 * and `reconcileClaim(records, self, { isStale })`.
 */
export function makeStaleClaimPredicate(
  nowS: number,
  config: ClaimStalenessConfig | ClaimReaperConfig = DEFAULT_CLAIM_REAPER,
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
  /** Workers whose latest marker withdrew from the issue. If every claim has
   * ended in concede while the issue still carries `running`, the label
   * projection is stranded and the boot sweep must repair it. */
  concededOwners: string[];
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
  const concededOwners: string[] = [];
  for (const [worker, f] of folds) {
    if (f.latestKind === "concede") {
      concededOwners.push(worker);
      continue; // withdrew
    }
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
  concededOwners.sort();
  return { liveOwner, staleOwners, concededOwners };
}

/** One claimed issue handed to the sweep: the issue number + its parsed claim
 * marker records (from `parseClaimRecords`). */
export interface ClaimedIssue {
  issue: number;
  records: readonly ClaimRecord[];
  /** Most recent commit epoch across this issue's live attempt branches. When
   * recent enough, it proves active progress even if the claim marker is old. */
  attemptBranchCommitS?: number;
  /** Remote attempt branches and their distance from trunk, for release audit. */
  attemptBranches?: readonly { branch: string; commitsAhead?: number }[];
  /** Claim owners proven dead on this host by their per-worker `worker.pid`. */
  deadOwners?: readonly string[];
  /** Claim owners proven LIVE on this host by their per-worker `worker.pid`.
   * Local process evidence overrides heartbeat age, so a busy local worker that
   * missed its refresh batch is never robbed by its own host's sweep. */
  liveOwners?: readonly string[];
}

/** A planned release: the issue to return to the executable pool + the stale
 * owners whose dead claim it recovered (for the audit comment). */
export interface StaleClaimRelease {
  issue: number;
  staleOwners: string[];
  concededOwners?: string[];
}

/** Render the single audit comment the boot sweep posts when it releases an
 * issue whose owner died on another host (#627) — the visible record that the
 * issue returned to the executable pool. */
export function renderStaleClaimSweepAudit(
  staleOwners: readonly string[],
  destination = "ready-for-agent",
): string {
  const who = staleOwners.map((w) => `\`${w}\``).join(", ");
  return (
    `🤖 AFK cross-host stale-claim sweep: released this issue back to \`${destination}\` — ` +
    `${staleOwners.length === 1 ? "the claim" : "the claims"} held by ${who} stopped refreshing ` +
    `past the staleness window (owner presumed dead on another host).`
  );
}

/** Render the audit comment for an immediate same-host ghost-claim release. */
export function renderDeadClaimSweepAudit(
  staleOwners: readonly string[],
  destination = "ready-for-agent",
): string {
  const who = staleOwners.map((w) => `\`${w}\``).join(", ");
  return (
    `🤖 AFK same-host ghost-claim sweep: released this issue back to \`${destination}\` — ` +
    `${staleOwners.length === 1 ? "the claim" : "the claims"} held by ${who} had a dead \`worker.pid\`.`
  );
}

/** Render the audit comment for a stranded label projection: all claim markers
 * ended in concede but the issue still carried `running`, so the sweep returned
 * it to the executable pool. */
export function renderConcededClaimSweepAudit(
  concededOwners: readonly string[],
  destination = "ready-for-agent",
): string {
  const who = concededOwners.map((w) => `\`${w}\``).join(", ");
  return (
    `🤖 AFK claim-label sweep: released this issue back to \`${destination}\` — ` +
    `${concededOwners.length === 1 ? "the latest claim marker" : "the latest claim markers"} for ${who} ` +
    `ended in concede while the issue was still labeled \`running\`.`
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
  config: ClaimReaperConfig = DEFAULT_CLAIM_REAPER,
): StaleClaimRelease[] {
  const isStale = makeStaleClaimPredicate(nowS, config);
  const releases: StaleClaimRelease[] = [];
  for (const c of claimed) {
    const deadOwners = new Set(c.deadOwners ?? []);
    const liveOwners = new Set(c.liveOwners ?? []);
    const state = classifyIssueClaims(c.records, (record) =>
      liveOwners.has(record.worker) ? false : deadOwners.has(record.worker) || isStale(record));
    if (state.liveOwner === null && state.staleOwners.length > 0) {
      const hasDeadOwner = state.staleOwners.some((owner) => deadOwners.has(owner));
      if (!hasDeadOwner && isRecentAttemptCommit(c.attemptBranchCommitS, nowS, config.recentCommitProtectionS)) continue;
      releases.push({ issue: c.issue, staleOwners: state.staleOwners });
      continue;
    }
    if (state.liveOwner === null && state.staleOwners.length === 0 && state.concededOwners.length > 0) {
      releases.push({ issue: c.issue, staleOwners: [], concededOwners: state.concededOwners });
    }
  }
  return releases;
}

function isRecentAttemptCommit(commitS: number | undefined, nowS: number, windowS: number): boolean {
  if (!Number.isFinite(commitS)) return false;
  const ageS = nowS - (commitS as number);
  // Future-dated commits can be clock skew, but they are still evidence that the
  // branch is moving; protect rather than rob.
  return ageS <= windowS;
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
 * (positive int, default 270) and `RED_AFK_CLAIM_STALE_TOLERANCE` (non-negative
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

export function resolveClaimReaperConfig(
  env: Record<string, string | undefined> = process.env,
  getCfg: (key: string) => string = () => "",
): ClaimReaperConfig {
  return {
    refreshCadenceS:
      resolvePositiveInt(env.RED_AFK_CLAIM_REFRESH_S, 0) ||
      resolvePositiveInt(getCfg("afk.claim_reaper.refresh_s"), DEFAULT_CLAIM_REFRESH_S),
    tolerance: resolveNonNegativeInt(
      env.RED_AFK_CLAIM_STALE_TOLERANCE,
      resolveNonNegativeInt(getCfg("afk.claim_reaper.stale_tolerance"), DEFAULT_CLAIM_STALE_TOLERANCE),
    ),
    claimGraceS:
      resolvePositiveInt(env.RED_AFK_CLAIM_REAPER_GRACE_S, 0) ||
      resolvePositiveInt(getCfg("afk.claim_reaper.grace_s"), DEFAULT_CLAIM_REAPER_GRACE_S),
    recentCommitProtectionS:
      resolvePositiveInt(env.RED_AFK_CLAIM_REAPER_RECENT_COMMIT_S, 0) ||
      resolvePositiveInt(
        getCfg("afk.claim_reaper.recent_commit_s"),
        DEFAULT_CLAIM_RECENT_COMMIT_PROTECTION_S,
      ),
  };
}
