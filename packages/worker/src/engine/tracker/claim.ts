// Atomic GitHub-native claim substrate (ADR 0066, issue #622, PRD #614) —
// unified single implementation (red-skills boundary consolidation).
//
// This module is the ONE owner of the claim wire format. The battle-proven
// implementation absorbed here previously lived in the consuming host
// (`apps/dev/src/core/claim.ts`, now a re-export shim); the earlier
// tracker-local twin (`renderTrackerClaimComment`/`parseTrackerClaimRecords`/
// `reconcileTrackerClaims`) is deleted — it had no production callers and
// predated the #2385 fail-loud hardening. The castle-only local FS lease layer
// (`createFsIssueLeaseStore`, `acquireIssueLease`, `retireIssueLease`) is
// retained and rebuilt on the absorbed core.
//
// Replaces the racy three-layer label claim (host-local mkdir lock → `running`
// label pre-check → label edit) with a GitHub-native primitive any claimant on
// any host can use: local fleet workers, other users' fleets, and GitHub Actions
// runners. The chosen ordered primitive is **structured claim-comment ordering**:
// every claimant posts a structured `<!-- afk:claim … -->` marker comment; GitHub
// assigns each comment a globally monotonic, server-side `id`, which is the total
// order across all hosts. The earliest active claim wins. See ADR 0066 for the
// rejected alternatives (assignee CAS, check-run).
//
// Structure — three layers, the diff one pure:
//
//   marker      renderClaimComment(self) / parseClaimRecords(comments) — the wire
//     format. parseClaimRecords is garbage-tolerant: any comment that is not a
//     well-formed afk:claim marker is silently skipped, so arbitrary issue chatter
//     (and malformed/forged markers) never corrupts the decision.
//
//   reconciler  reconcileClaim(records, self, opts) — PURE. Given the parsed claim
//     records plus the claimant's own identity + comment id, returns won | lost
//     and the winner. No I/O. Liveness/staleness is injected via opts.isStale,
//     so cross-host stale-claim recovery stays a pure function of injected facts.
//
//   orchestrator  acquireClaim(gh, self, issue, opts) — the thin impure shell with
//     the GitHub client injected: post our claim → list claim markers → reconcile →
//     concede (best-effort) if we lost. The verdict is computed by the pure layer;
//     this layer only performs the side effects.
//
// Labels (`running` etc.) are no longer the lock. They remain an observability
// PROJECTION applied best-effort by the caller and are never consulted to
// arbitrate a winner.

import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Runner } from "../runner-types.js";

/** Marker schema version. Bump only on an incompatible wire-format change so old
 * markers left on long-lived issues still parse (or are cleanly ignored). */
export const CLAIM_MARKER_VERSION = 1;

/** What a claimant is currently expressing. A `claim` contends for the issue; a
 * `concede` withdraws a prior claim (posted when a worker loses the race or
 * releases voluntarily). */
export type ClaimKind = "claim" | "concede";

/** Why a `concede` was posted. The two causes are operationally opposite — one
 * says another worker owns the issue, the other says we owned it and let go —
 * and the single ambiguous sentence they used to share ("lost the claim race or
 * released") turned a crashed worker's release into a phantom claim race in
 * every post-mortem (#2385). `unspecified` keeps legacy callers rendering the
 * old wording. */
export type ConcedeReason = "lost" | "released" | "stale" | "unspecified";

const CONCEDE_WORDING: Record<ConcedeReason, string> = {
  lost: "lost the claim race to an earlier claimant",
  released: "released the claim it held",
  stale: "was released after its heartbeat exceeded the staleness window",
  unspecified: "lost the claim race or released",
};

/** One parsed claim marker. `commentId` is GitHub's server-assigned monotonic
 * comment id — the total order that makes the primitive atomic across hosts. */
export interface ClaimRecord {
  /** Server-assigned monotonic issue-comment id. The cross-host total order. */
  commentId: number;
  /** Claimant identity, `host:worker_id` — unique per worker process per host. */
  worker: string;
  kind: ClaimKind;
  /** Runner that posted the marker (advisory; for logs/observability). */
  runner?: string;
  /** Server-assigned ISO createdAt (advisory; backs opts.isStale staleness). */
  createdAt?: string;
}

/** The claimant's own identity and the id GitHub assigned to its claim comment. */
export interface ClaimSelf {
  /** Our `host:worker_id`. */
  worker: string;
  /** The comment id GitHub returned for OUR posted claim. */
  commentId: number;
  runner?: Runner;
  createdAt?: string;
}

export type ClaimVerdict = "won" | "lost";

/**
 * A claim could not be VERIFIED — our own just-posted marker never came back
 * from the read-back, or reconciliation dropped it. Thrown, never folded into a
 * `lost` verdict: "we could not check" is not "somebody else won" (#2385). The
 * caller surfaces it as a session error so the dispatch fails loudly instead of
 * conceding an issue nobody else contends.
 */
import { ClaimVerificationError, listVerifiedClaims } from "./claim-verification.js";

export {
  ClaimVerificationError,
  type ClaimVerificationFailure,
} from "./claim-verification.js";

export interface ClaimDecision {
  verdict: ClaimVerdict;
  /** The winning claimant's `worker` key, or null when no live claim contends
   * (only possible if `self` was not supplied to the reconciler — a usage error
   * the orchestrator never triggers). */
  winner: string | null;
  /** One-line rationale, for logs. */
  reason: string;
  /** The winning claimant's earliest claim comment id, for operator diagnostics. */
  winnerClaimId?: number;
  /** The timestamp attached to the winning claimant's latest marker, when known. */
  winnerCreatedAt?: string;
  /** Stale cross-host claimants this decision RECOVERED — workers whose latest
   * marker `isStale` rejected and who would otherwise have held an earlier claim
   * than the winner. Empty unless a stale claim was superseded. Drives the single
   * audit comment the orchestrator posts on a recovery (issue #627). */
  recovered: string[];
}

export interface ClaimReconcileOptions {
  /** Injected liveness/staleness predicate. A record for which this returns
   * true is treated as a dead/expired claim and does not contend — this is how
   * a stale cross-host winner is recovered. Pure: the caller computes staleness
   * (TTL on createdAt, known-dead worker set, …) and injects the verdict so the
   * reconciler stays I/O-free. Defaults to "never stale". */
  isStale?: (record: ClaimRecord) => boolean;
}

// ---------- marker layer ----------

const MARKER_OPEN = "<!-- afk:claim";
// e.g. `<!-- afk:claim v1 worker=mbp.local:w6HSO-3 kind=claim runner=claude ts=2026-06-10T23:10:24Z -->`
const MARKER_RE = /<!--\s*afk:claim\s+([^>]*?)\s*-->/g;

function escapeField(value: string): string {
  // Fields are space-delimited key=value pairs inside an HTML comment. Strip the
  // characters that would break parsing; identities are already constrained to
  // host/worker charsets, this is defence-in-depth against a forged title.
  return value.replace(/[\s>]/g, "_");
}

/** Render the one-line audit comment posted when a claim recovered a stale
 * cross-host claim — the visible record that the issue returned to the
 * executable pool because an owner stopped refreshing (#627).
 *
 * When `deathFor` is supplied, it resolves each recovered owner's death cause
 * (from its process-safety diagnostic log, when same-host and readable). Any
 * resolved causes are appended so the comment SAYS why the predecessor died —
 * "uncatchable death (likely SIGKILL/OOM) at ~HH:MM" — instead of only
 * "stopped refreshing". This is what makes the Pattern 5 diagnostic actionable:
 * the next worker's recovery comment carries the forensic verdict. `deathFor`
 * returning null (cross-host, no log, or still-running) omits that owner's
 * clause, so the comment degrades to the original wording when nothing is
 * known. */
export function renderRecoveryAudit(
  self: { worker: string },
  recovered: readonly string[],
  deathFor?: (recoveredWorker: string) => string | null,
): string {
  const who = recovered.map((w) => `\`${w}\``).join(", ");
  const base =
    `🤖 AFK cross-host recovery: worker \`${self.worker}\` released ${recovered.length === 1 ? "a stale claim" : "stale claims"} ` +
    `held by ${who} (owner stopped refreshing past the staleness window) and re-claimed this issue.`;
  if (!deathFor) return base;
  const causes = recovered
    .map((w) => {
      const cause = deathFor(w);
      return cause ? `\`${w}\`: ${cause}` : null;
    })
    .filter((c): c is string => c !== null);
  if (causes.length === 0) return base;
  return `${base}\n\nPredecessor cause${causes.length === 1 ? "" : "s"} (process-safety diagnostic): ${causes.join("; ")}.`;
}

/** Render the structured claim/concede marker comment a claimant posts. The
 * leading HTML-comment marker carries the machine fields; the trailing line is
 * the human-visible projection in the issue thread. */
export function renderClaimComment(
  self: {
    worker: string;
    runner?: string;
    createdAt?: string;
    /** Evictor identity, when this concede was written ON BEHALF of `worker`. */
    concededBy?: string;
    /** The evicted holder's last observed heartbeat timestamp (evidence). */
    lastHeartbeatAt?: string;
    /** Age in seconds of that heartbeat at eviction time (evidence). */
    heartbeatAgeS?: number;
  },
  kind: ClaimKind = "claim",
  reason?: ConcedeReason,
): string {
  const fields = [
    `v${CLAIM_MARKER_VERSION}`,
    `worker=${escapeField(self.worker)}`,
    `kind=${kind}`,
  ];
  if (kind === "concede" && reason) fields.push(`reason=${escapeField(reason)}`);
  if (kind === "concede" && self.concededBy) fields.push(`by=${escapeField(self.concededBy)}`);
  if (kind === "concede" && self.lastHeartbeatAt) {
    fields.push(`last-heartbeat=${escapeField(self.lastHeartbeatAt)}`);
  }
  if (kind === "concede" && self.heartbeatAgeS !== undefined) {
    fields.push(`heartbeat-age-s=${self.heartbeatAgeS}`);
  }
  if (self.runner) fields.push(`runner=${escapeField(self.runner)}`);
  if (self.createdAt) fields.push(`ts=${escapeField(self.createdAt)}`);
  const marker = `${MARKER_OPEN} ${fields.join(" ")} -->`;
  const human = kind === "claim"
    ? `🤖 AFK claim by worker \`${self.worker}\`${self.runner ? ` (runner \`${self.runner}\`)` : ""}.`
    : reason === "stale" && self.concededBy
      ? `🤖 AFK worker \`${self.worker}\` was conceded on behalf by \`${self.concededBy}\` ` +
        `(${CONCEDE_WORDING.stale}${self.lastHeartbeatAt ? `; last heartbeat \`${self.lastHeartbeatAt}\`` : ""}` +
        `${self.heartbeatAgeS !== undefined ? `; age ${self.heartbeatAgeS}s` : ""}).`
      : `🤖 AFK worker \`${self.worker}\` conceded this issue (${CONCEDE_WORDING[reason ?? "unspecified"]}).`;
  return `${marker}\n${human}`;
}

/**
 * Render the sanctioned stale-owner withdrawal an evictor writes on behalf of a
 * dead remote holder. Same marker grammar as a self-concede — so every reader
 * folds it identically — plus the staleness evidence (`by`, `last-heartbeat`,
 * `heartbeat-age-s`) that says WHO evicted and WHY the holder was presumed dead.
 */
export function renderConcedeOnBehalf(
  owner: string,
  evictor: string,
  lastHeartbeatAt?: string,
  heartbeatAgeS?: number,
): string {
  return renderClaimComment(
    { worker: owner, concededBy: evictor, lastHeartbeatAt, heartbeatAgeS },
    "concede",
    "stale",
  );
}

/** A raw issue comment as read from GitHub (`gh issue view --json comments` /
 * the issue timeline). Only the fields the parser needs. */
export interface RawClaimComment {
  /** Server-assigned monotonic comment id. */
  id: number;
  body: string;
  createdAt?: string;
}

function parseFields(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const tok of raw.split(/\s+/)) {
    const eq = tok.indexOf("=");
    if (eq <= 0) continue;
    out.set(tok.slice(0, eq), tok.slice(eq + 1));
  }
  return out;
}

/**
 * Parse claim markers out of a comment list (the marker layer). Garbage-tolerant
 * by construction: a comment with no marker, a malformed marker, or a marker
 * missing the required `worker` field is skipped, never throwing. A single
 * comment may legitimately carry at most one marker; if a forged body embeds
 * several, each is read but they all share the comment's id (same order slot), so
 * no forger can claim a lower id than GitHub actually assigned them.
 */
export function parseClaimRecords(comments: readonly RawClaimComment[]): ClaimRecord[] {
  const out: ClaimRecord[] = [];
  for (const c of comments) {
    if (typeof c.id !== "number" || !Number.isFinite(c.id) || typeof c.body !== "string") {
      continue;
    }
    MARKER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MARKER_RE.exec(c.body)) !== null) {
      const fields = parseFields(m[1] ?? "");
      const worker = fields.get("worker");
      if (!worker) continue; // malformed marker — skip, stay garbage-tolerant.
      const kindRaw = fields.get("kind");
      const kind: ClaimKind = kindRaw === "concede" ? "concede" : "claim";
      out.push({
        commentId: c.id,
        worker,
        kind,
        runner: fields.get("runner"),
        createdAt: fields.get("ts") ?? c.createdAt,
      });
    }
  }
  return out;
}

// ---------- reconciler layer (PURE) ----------

interface Contender {
  worker: string;
  /** Earliest claim comment id — the order key (first-claim-wins). */
  claimId: number;
}

/**
 * Decide the single winner from the claim records plus our own identity (the
 * pure reconciler). Algorithm:
 *
 *   1. Fold records per worker into their current intent: the marker with the
 *      highest commentId (their latest word) decides whether they still contend.
 *      A worker whose latest marker is `concede` has withdrawn.
 *   2. A contending worker's order key is its EARLIEST `claim` id — re-posting a
 *      claim never improves your position, so a flapping claimant cannot jump the
 *      queue.
 *   3. Drop contenders the injected `isStale` predicate rejects (dead/expired) —
 *      this is cross-host stale-claim recovery.
 *   4. `self` is always merged in at `self.commentId` (read-after-write may not
 *      yet reflect our own comment), so the decision is stable.
 *   5. The lowest surviving claimId wins. Ties (same id — impossible from GitHub,
 *      possible only in malformed input) break by worker string for determinism.
 *
 * Returns `won` iff `self.worker` is that winner.
 */
export function reconcileClaim(
  records: readonly ClaimRecord[],
  self: ClaimSelf,
  opts: ClaimReconcileOptions = {},
): ClaimDecision {
  const isStale = opts.isStale ?? (() => false);

  // An unusable identity means the claim could not be VERIFIED at all — an
  // unparseable POST response or a blank worker key. Never fold that into
  // "lost": the caller must retry or fail, not concede to nobody (#2385).
  if (!Number.isFinite(self.commentId) || self.worker === "") {
    throw new ClaimVerificationError(
      `claim verification failed: unusable claimant identity (worker ${JSON.stringify(self.worker)}, ` +
        `comment id ${String(self.commentId)})`,
    );
  }

  // Per-worker fold: earliest claim id + latest marker (kind + record).
  interface Fold {
    earliestClaimId: number | null;
    latestId: number;
    latestKind: ClaimKind;
    latestRecord: ClaimRecord;
  }
  const folds = new Map<string, Fold>();

  const ingest = (r: ClaimRecord) => {
    if (!Number.isFinite(r.commentId) || r.worker === "") return;
    const f = folds.get(r.worker);
    if (f === undefined) {
      folds.set(r.worker, {
        earliestClaimId: r.kind === "claim" ? r.commentId : null,
        latestId: r.commentId,
        latestKind: r.kind,
        latestRecord: r,
      });
      return;
    }
    if (r.kind === "claim" && (f.earliestClaimId === null || r.commentId < f.earliestClaimId)) {
      f.earliestClaimId = r.commentId;
    }
    if (r.commentId >= f.latestId) {
      f.latestId = r.commentId;
      f.latestKind = r.kind;
      f.latestRecord = r;
    }
  };

  // Did WE just post the marker we are reconciling? True when `self.commentId`
  // is at least as new as every marker the list already carries — i.e. our claim
  // is the freshest word on the issue. Equality is required because verified
  // read-back includes our just-posted marker. A caller re-reconciling an OLD claim
  // of its own (the returning stale owner) is not fresh, and stays subject to the
  // staleness predicate that reclaimed its issue.
  const selfPostedFresh =
    Number.isFinite(self.commentId) &&
    records.every((r) => r.commentId <= self.commentId);

  for (const r of records) ingest(r);
  // Always merge self in (read-after-write safety). Our own marker is a `claim`.
  ingest({
    commentId: self.commentId,
    worker: self.worker,
    kind: "claim",
    runner: self.runner,
    createdAt: self.createdAt,
  });

  const contenders: Contender[] = [];
  // Stale claimants that would have out-ordered us, captured so the orchestrator
  // can post one audit comment recording the cross-host recovery (#627).
  const stale: Contender[] = [];
  for (const [worker, f] of folds) {
    if (f.latestKind === "concede") continue; // withdrew
    if (f.earliestClaimId === null) continue; // only ever conceded — not a claim
    // A JUST-POSTED self is never stale (#2385): we wrote that marker moments
    // ago, so a predicate rejecting it can only be a clock-skew or
    // timestamp-parse defect — and dropping ourselves made a SOLE claimant fall
    // through to "no live claim contends" and concede its own freshly minted
    // issue. A returning owner re-reading its OLD claim stays stale-eligible.
    if (!(worker === self.worker && selfPostedFresh) && isStale(f.latestRecord)) {
      stale.push({ worker, claimId: f.earliestClaimId }); // dead/expired — recovered
      continue;
    }
    contenders.push({ worker, claimId: f.earliestClaimId });
  }

  if (contenders.length === 0) {
    if (selfPostedFresh) {
      // Unreachable for a just-posted claim: `self` is merged in as a live claim
      // above and is stale-exempt, so an empty contender set means our own
      // identity was unusable (empty worker key). That is a VERIFICATION
      // failure, never a lost race — fail loudly instead of conceding (#2385).
      throw new ClaimVerificationError(
        `claim verification failed on the reconciler: our own claim (worker ${JSON.stringify(self.worker)}, ` +
          `comment id ${String(self.commentId)}) did not survive reconciliation — no live claim contends`,
      );
    }
    // Not a fresh post: we are re-reading an old claim of ours that has since
    // been conceded or aged out. Nobody contends and we do not hold it.
    return { verdict: "lost", winner: null, reason: "no live claim contends", recovered: [] };
  }

  contenders.sort((a, b) => a.claimId - b.claimId || (a.worker < b.worker ? -1 : 1));
  // Non-empty by the guard above; index access is checked under this tsconfig.
  const winner = contenders[0]!;

  // A recovery is real only when we WIN and a stale claimant out-ordered us —
  // i.e. it would have beaten the winner had it not aged out. A stale claim that
  // posted AFTER the winner never held the issue, so it is not "recovered".
  const recovered =
    winner.worker === self.worker
      ? stale.filter((s) => s.claimId < winner.claimId).map((s) => s.worker).sort()
      : [];

  if (winner.worker === self.worker) {
    return {
      verdict: "won",
      winner: winner.worker,
      winnerClaimId: winner.claimId,
      winnerCreatedAt: folds.get(winner.worker)?.latestRecord.createdAt,
      reason:
        contenders.length === 1
          ? "solo claim"
          : `earliest of ${contenders.length} live claims (id ${winner.claimId})`,
      recovered,
    };
  }
  return {
    verdict: "lost",
    winner: winner.worker,
    winnerClaimId: winner.claimId,
    winnerCreatedAt: folds.get(winner.worker)?.latestRecord.createdAt,
    reason: `worker ${winner.worker} holds earlier claim (id ${winner.claimId} < our ${self.commentId})`,
    recovered: [],
  };
}

// ---------- orchestrator layer (injected IO) ----------

/** GitHub side effects the claim orchestrator drives. Each maps to a `gh` call;
 * kept out of the module so the decision stays I/O-free. */
export interface ClaimGh {
  /** Post our claim marker comment; resolve the new comment's server id. */
  postClaim(issue: number, body: string): Promise<number>;
  /** Read the issue's claim marker comments ({id, body, createdAt}). */
  listClaims(issue: number): Promise<RawClaimComment[]>;
  /** Post a concede marker (best-effort; a failed concede is non-fatal — our
   * claim simply ages out via staleness). */
  concede(issue: number, body: string): Promise<void>;
  /** Post the single human-visible audit comment when this claim RECOVERED a
   * stale cross-host claim (#627). Optional + best-effort: a failed audit does
   * not abandon the won claim. Omitted by legacy callers (no audit posted). */
  audit?(issue: number, body: string): Promise<void>;
  /** Edit an existing claim marker IN PLACE for a heartbeat refresh. Resolving
   * `false` reports a refused edit (comment gone, permission denied) so the batch
   * records a skip instead of a bogus fresh heartbeat. Optional: a caller without
   * it simply never refreshes. */
  editClaim?(commentId: number, body: string): Promise<boolean | void>;
}

/** One locally-held claim considered by the fleet's shared heartbeat cadence. */
export interface ClaimHeartbeat {
  issue: number;
  worker: string;
  runner?: Runner;
  /** Server comment id of the holder's existing claim marker. */
  commentId: number;
  /** Epoch seconds carried by the holder's latest claim marker. */
  lastHeartbeatS: number;
}

export interface ClaimHeartbeatBatchResult {
  /** Issues whose marker was refreshed in this pass. */
  refreshed: number[];
  /** Issues left alone — not yet due, or the edit was refused. */
  skipped: number[];
}

/**
 * Refresh every DUE local claim in ONE fleet maintenance pass. The caller owns
 * the single cadence; this function owns no timer, which is what keeps the shared
 * GitHub quota bounded — one batch per fleet tick, not one polling loop per
 * worker. A claim younger than `cadenceS` is skipped without an API call, so the
 * call count is exactly the number of due claims.
 *
 * A refresh EDITS the holder's existing claim marker, preserving its server-order
 * id: a refresh can never improve queue position, and a later concede stays the
 * holder's authoritative last word.
 */
export async function refreshClaimHeartbeats(
  gh: Required<Pick<ClaimGh, "editClaim">>,
  claims: readonly ClaimHeartbeat[],
  nowS: number,
  cadenceS: number,
): Promise<ClaimHeartbeatBatchResult> {
  const refreshed: number[] = [];
  const skipped: number[] = [];
  for (const claim of claims) {
    if (nowS - claim.lastHeartbeatS < cadenceS) {
      skipped.push(claim.issue);
      continue;
    }
    const edited = await gh.editClaim(
      claim.commentId,
      renderClaimComment(
        {
          worker: claim.worker,
          runner: claim.runner,
          createdAt: new Date(nowS * 1000).toISOString(),
        },
        "claim",
      ),
    );
    if (edited === false) {
      skipped.push(claim.issue);
      continue;
    }
    refreshed.push(claim.issue);
  }
  return { refreshed, skipped };
}

export interface AcquireClaimOptions extends ClaimReconcileOptions {
  /** Skip posting the human-facing concede when we lose (kept for tests). */
  suppressConcede?: boolean;
  /**
   * Resolve a recovered stale-claim owner's death cause for the recovery audit
   * comment (Pattern 5 — make the diagnostic actionable). Injected so claim.ts
   * stays pure; the runtime binds it to `deathCauseForRecoveredWorker`.
   * Absent → the comment keeps its original wording.
   */
  deathFor?: (recoveredWorker: string) => string | null;
  /** Read-back attempts allowed before a claim is declared unverifiable (#2385).
   * GitHub's comment list is read-your-write in practice but not guaranteed, and
   * the gh layer degrades a failed list call to an empty array — both looked
   * exactly like "nobody claimed, including us". Default 3. */
  verifyAttempts?: number;
  /** Milliseconds to wait between read-back attempts. Default 1000. */
  verifyDelayMs?: number;
  /** Injected sleep so the retry loop is testable without a real clock. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected epoch seconds used in stale-heartbeat concede evidence. */
  nowS?: number;
}

/**
 * Attempt to claim `issue` for `self` via the GitHub-native primitive: post our
 * claim marker, read all markers, run the pure reconciler, and concede cleanly if
 * we lost. Returns the decision; the caller (process-issue) maps `lost` to the
 * `claim-lost` outcome (no envelope, next issue picked) and projects labels only
 * on `won`.
 */
export async function acquireClaim(
  gh: ClaimGh,
  self: { worker: string; runner?: Runner; createdAt?: string },
  issue: number,
  opts: AcquireClaimOptions = {},
): Promise<ClaimDecision> {
  const commentId = await gh.postClaim(
    issue,
    renderClaimComment({ worker: self.worker, runner: self.runner, createdAt: self.createdAt }, "claim"),
  );
  const raw = await listVerifiedClaims(gh, issue, commentId, opts);
  const records = parseClaimRecords(raw);
  const decision = reconcileClaim(records, { ...self, commentId }, opts);
  if (decision.verdict === "lost" && !opts.suppressConcede) {
    await gh.concede(
      issue,
      renderClaimComment({ worker: self.worker, runner: self.runner }, "concede", "lost"),
    );
  }
  // Evicting a stale remote holder goes through the SAME concede path a holder
  // uses to release itself — one marker grammar, one mutation surface — carrying
  // the staleness evidence that justified the eviction.
  if (decision.verdict === "won" && decision.recovered.length > 0) {
    for (const owner of decision.recovered) {
      const latest = records
        .filter((record) => record.worker === owner)
        .sort((a, b) => b.commentId - a.commentId)[0];
      const lastHeartbeatS = latest?.createdAt ? Math.floor(Date.parse(latest.createdAt) / 1000) : Number.NaN;
      const heartbeatAgeS = Number.isFinite(lastHeartbeatS)
        ? Math.max(0, (opts.nowS ?? Math.floor(Date.now() / 1000)) - lastHeartbeatS)
        : undefined;
      await gh.concede(
        issue,
        renderConcedeOnBehalf(owner, self.worker, latest?.createdAt, heartbeatAgeS),
      );
    }
  }
  // One audit comment when we won by recovering a stale cross-host claim (#627).
  // Best-effort: a failed audit never abandons the won claim.
  if (decision.verdict === "won" && decision.recovered.length > 0 && gh.audit) {
    try {
      await gh.audit(issue, renderRecoveryAudit({ worker: self.worker }, decision.recovered, opts.deathFor));
    } catch {
      // best-effort observability; the claim is already won.
    }
  }
  return decision;
}

// ---------- local FS lease layer (castle-only, composed over the core) ----------

export type TrackerClaimLiveness = "alive" | "dead" | "unknown";

export interface TrackerClaimIdentity {
  readonly worker: string;
  readonly runner?: string;
}

/** Remote claim store the lease composition drives — structurally a `ClaimGh`
 * without the optional audit hook. */
export interface TrackerClaimStore {
  postClaim(issue: number, body: string): Promise<number>;
  listClaims(issue: number): Promise<RawClaimComment[]>;
  concede(issue: number, body: string): Promise<void>;
}

export interface LocalIssueLeaseStore {
  acquire(
    issue: number,
    owner: string,
    liveness: (worker: string) => TrackerClaimLiveness,
  ): Promise<LocalLeaseDecision>;
  release(issue: number, owner: string): Promise<void>;
}

export type LocalLeaseDecision =
  | { readonly acquired: true; readonly previousOwner?: string }
  | {
      readonly acquired: false;
      readonly owner: string;
      readonly reason:
        | "local lease owner is alive"
        | "local lease owner liveness unknown"
        // A dead holder was observed but another reclaimer won the atomic-rename
        // steal (or a fresh claimer re-mkdir'd first) — the #568 recovery race,
        // resolved in favour of exactly one winner. We are not that winner.
        | "lost local lease reclaim race";
    };

export interface AcquireIssueLeaseOptions {
  readonly issue: number;
  readonly identity: TrackerClaimIdentity;
  readonly local: LocalIssueLeaseStore;
  readonly remote: TrackerClaimStore;
  readonly liveness: (worker: string) => TrackerClaimLiveness;
  /** Optional additional record-level staleness (TTL on `ts`/createdAt), OR-ed
   * with the worker-level `liveness === "dead"` bridge. */
  readonly isStale?: (record: ClaimRecord) => boolean;
  /** Read-back verification knobs forwarded to `acquireClaim` (#2385). */
  readonly verifyAttempts?: number;
  readonly verifyDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface RetireIssueLeaseOptions {
  readonly issue: number;
  readonly identity: TrackerClaimIdentity;
  readonly local: LocalIssueLeaseStore;
  readonly remote: TrackerClaimStore;
}

/**
 * Dual lease: the local mkdir lease serializes claimants on one host, then the
 * GitHub-native `acquireClaim` arbitrates across hosts. Worker-level liveness
 * bridges into the record-level staleness predicate (`dead` → stale), so a dead
 * owner's remote claim is recovered exactly as a TTL-stale one would be. On a
 * lost race — or a thrown `ClaimVerificationError` — the local lease is
 * released so the host slot never strands.
 */
export async function acquireIssueLease(
  options: AcquireIssueLeaseOptions,
): Promise<ClaimDecision> {
  const local = await options.local.acquire(
    options.issue,
    options.identity.worker,
    options.liveness,
  );
  if (!local.acquired) {
    return {
      verdict: "lost",
      winner: local.owner,
      reason: local.reason,
      recovered: [],
    };
  }

  const isStale = (record: ClaimRecord): boolean =>
    options.liveness(record.worker) === "dead" ||
    (options.isStale?.(record) ?? false);

  let decision: ClaimDecision;
  try {
    decision = await acquireClaim(
      options.remote,
      { worker: options.identity.worker, runner: options.identity.runner as Runner | undefined },
      options.issue,
      {
        isStale,
        verifyAttempts: options.verifyAttempts,
        verifyDelayMs: options.verifyDelayMs,
        sleep: options.sleep,
      },
    );
  } catch (error) {
    await options.local.release(options.issue, options.identity.worker);
    throw error;
  }
  if (decision.verdict === "lost") {
    await options.local.release(options.issue, options.identity.worker);
  }
  return decision;
}

/** Voluntary release: concede the remote claim (`reason=released`) and release
 * the local lease. */
export async function retireIssueLease(
  options: RetireIssueLeaseOptions,
): Promise<void> {
  await options.remote.concede(
    options.issue,
    renderClaimComment(options.identity, "concede", "released"),
  );
  await options.local.release(options.issue, options.identity.worker);
}

/** Optional wiring for the FS lease store. */
export interface FsIssueLeaseStoreOptions {
  /** Pid recorded in the lease's `pid` file (default `process.pid`). Matched on
   * idempotent re-acquire and on the ownership-guarded pid fallback in release. */
  readonly pid?: number;
  /** Injected pid-liveness predicate — castle stays liveness-I/O-free (ADR 0114),
   * so the host injects `kill -0`. Absent → every pid verdict is `"unknown"`,
   * which is safe: an unknown holder is never stolen from. */
  readonly pidAlive?: (pid: number) => TrackerClaimLiveness;
}

/**
 * The local per-host issue lease, rebuilt on dev's battle-proven mkdir-lock
 * semantics (#434 atomic claim, #568 atomic-rename recovery) so there is ONE
 * lease implementation. The leaf dir `<root>/<issue>/` IS the lock: a
 * non-recursive `mkdir` is the POSIX-atomic primitive (fails `EEXIST` when held),
 * so exactly one of N racing claimants wins. The dir carries BOTH a `pid` file
 * (decimal, no trailing newline — byte-identical to every dev sweep reader) and
 * an `owner` file (`<owner>\n`), the transition-compatible union of the two prior
 * on-disk formats.
 *
 * Liveness composes two independent signals so a legacy dir written in either
 * format still recovers correctly: the injected `pidAlive(holderPid)` (the dev
 * format's `pid` file) and the caller's `liveness(ownerToken)` (the castle
 * format's `owner` file). A dead holder is reclaimed through the atomic-rename
 * steal — of N reclaimers racing the SAME stale dir, exactly one rename wins and
 * the losers bail — which is what closed the #568 TOCTOU that a plain rm+mkdir
 * reopened.
 */
export function createFsIssueLeaseStore(
  root: string,
  options: FsIssueLeaseStoreOptions = {},
): LocalIssueLeaseStore {
  const pid = options.pid ?? process.pid;
  const pidAlive = options.pidAlive ?? (() => "unknown" as TrackerClaimLiveness);
  return {
    acquire: (issue, owner, liveness) =>
      acquireFsIssueLease(root, issue, owner, liveness, pid, pidAlive),
    release: (issue, owner) => releaseFsIssueLease(root, issue, owner, pid),
  };
}

/** Monotonic per-process counter so concurrent stale-lease reclaims (even from
 * the same pid) each rename to a UNIQUE quarantine dir — the atomic rename of the
 * shared lease dir serialises the winners, so the rename targets must not collide
 * (ported from the dev `claimReclaimSeq`, fs.ts). */
let leaseReclaimSeq = 0;

async function acquireFsIssueLease(
  root: string,
  issue: number,
  owner: string,
  liveness: (worker: string) => TrackerClaimLiveness,
  pid: number,
  pidAlive: (pid: number) => TrackerClaimLiveness,
): Promise<LocalLeaseDecision> {
  const leaseDir = issueLeaseDir(root, issue);
  await mkdir(root, { recursive: true });

  // Fast path: win the exclusive non-recursive mkdir → we hold the lease.
  if (await tryMkdirLease(leaseDir)) {
    await writeLeaseFiles(leaseDir, owner, pid);
    return { acquired: true };
  }

  // Held. Read the holder's identity from BOTH files (either may be absent on a
  // legacy dir; both absent on a blank/corrupt dir).
  const holderOwner = await readLeaseOwner(leaseDir);
  const holderPid = await readLeasePid(leaseDir);

  // Idempotent re-acquire: ours by owner token; the pid fallback applies ONLY
  // to a legacy dev-format dir with no owner file — a readable owner token that
  // differs is a DIFFERENT worker even from the same pid (one supervisor
  // process claims on behalf of many workers).
  if (
    holderOwner === owner ||
    (holderOwner === undefined && holderPid !== undefined && holderPid === pid)
  ) {
    await refreshLeaseFiles(leaseDir, owner, pid, holderOwner, holderPid);
    return { acquired: true };
  }

  const verdict = holderLivenessVerdict(holderPid, holderOwner, liveness, pidAlive);
  const heldBy = holderOwner ?? (holderPid !== undefined ? String(holderPid) : "unknown");

  if (verdict === "alive") {
    return { acquired: false, owner: heldBy, reason: "local lease owner is alive" };
  }
  if (verdict === "unknown") {
    return { acquired: false, owner: heldBy, reason: "local lease owner liveness unknown" };
  }

  // Dead holder → reclaim ATOMICALLY (#568). rename(2) is atomic, so of N racing
  // reclaimers of the SAME stale dir exactly one rename succeeds; the losers get
  // ENOENT and bail with the reclaim-race verdict. The winner deletes the
  // quarantined dir and re-claims through the exclusive mkdir, which still
  // serialises against any fresh claimer that slipped in after the rename.
  const quarantine = `${leaseDir}.stale-${pid}-${leaseReclaimSeq++}`;
  await rm(quarantine, { recursive: true, force: true }).catch(() => {});
  try {
    await rename(leaseDir, quarantine);
  } catch {
    return { acquired: false, owner: heldBy, reason: "lost local lease reclaim race" };
  }
  await rm(quarantine, { recursive: true, force: true });
  if (!(await tryMkdirLease(leaseDir))) {
    // A fresh claimer won the re-mkdir between our rename and now.
    return { acquired: false, owner: heldBy, reason: "lost local lease reclaim race" };
  }
  await writeLeaseFiles(leaseDir, owner, pid);
  return { acquired: true, previousOwner: heldBy };
}

/**
 * Compose the holder's liveness from the pid signal (dev format) and the
 * owner-token signal (castle format):
 *   - `"alive"` if either signal says alive;
 *   - else `"dead"` if either signal says dead, OR neither file is readable (the
 *     corrupt/blank dir the dev #434 tests treat as reclaimable);
 *   - else `"unknown"` (safe: an unknown holder is never stolen from).
 * A missing/blank pid file WITH a readable owner file defers ENTIRELY to
 * `liveness(ownerToken)` — the pure castle legacy path, where the host injects no
 * pid liveness for that record.
 */
function holderLivenessVerdict(
  holderPid: number | undefined,
  holderOwner: string | undefined,
  liveness: (worker: string) => TrackerClaimLiveness,
  pidAlive: (pid: number) => TrackerClaimLiveness,
): TrackerClaimLiveness {
  const pidReadable = holderPid !== undefined;
  const ownerReadable = holderOwner !== undefined;

  // Owner-only legacy dir (castle format): defer entirely to injected liveness.
  if (!pidReadable && ownerReadable) return liveness(holderOwner as string);

  const pidVerdict = pidReadable ? pidAlive(holderPid as number) : undefined;
  const ownerVerdict = ownerReadable ? liveness(holderOwner as string) : undefined;

  if (pidVerdict === "alive" || ownerVerdict === "alive") return "alive";
  if (pidVerdict === "dead" || ownerVerdict === "dead" || (!pidReadable && !ownerReadable)) {
    return "dead";
  }
  return "unknown";
}

/**
 * Voluntary/lost release, ownership-guarded: remove the lease dir iff it is ours
 * — the owner file matches, OR the owner file is absent while the `pid` file
 * matches our recorded pid, OR the dir is already gone. A mismatched live owner's
 * lease is left untouched, so a release on a lost race never steals a peer's slot.
 */
async function releaseFsIssueLease(
  root: string,
  issue: number,
  owner: string,
  pid: number,
): Promise<void> {
  const leaseDir = issueLeaseDir(root, issue);
  try {
    await stat(leaseDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // already gone
    throw err;
  }
  const holderOwner = await readLeaseOwner(leaseDir);
  const holderPid = await readLeasePid(leaseDir);
  const ownerMatches = holderOwner !== undefined && holderOwner === owner;
  const pidFallback = holderOwner === undefined && holderPid !== undefined && holderPid === pid;
  if (ownerMatches || pidFallback) {
    await rm(leaseDir, { recursive: true, force: true });
  }
}

async function tryMkdirLease(leaseDir: string): Promise<boolean> {
  try {
    await mkdir(leaseDir, { recursive: false }); // non-recursive → EEXIST when held
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/** Write both lease files. `pid` is decimal with NO trailing newline so every dev
 * sweep reader (`listStaleClaimDirs`, `claimPathHeldByLivePid`, …) reads it
 * byte-for-byte; `owner` carries its trailing newline. */
async function writeLeaseFiles(leaseDir: string, owner: string, pid: number): Promise<void> {
  await writeFile(join(leaseDir, "pid"), String(pid), "utf8");
  await writeFile(join(leaseDir, "owner"), `${owner}\n`, "utf8");
}

/** Idempotent re-acquire: fill in whichever lease file is missing without
 * clobbering a present one. */
async function refreshLeaseFiles(
  leaseDir: string,
  owner: string,
  pid: number,
  holderOwner: string | undefined,
  holderPid: number | undefined,
): Promise<void> {
  if (holderPid === undefined) await writeFile(join(leaseDir, "pid"), String(pid), "utf8");
  if (holderOwner === undefined) await writeFile(join(leaseDir, "owner"), `${owner}\n`, "utf8");
}

async function readLeaseOwner(leaseDir: string): Promise<string | undefined> {
  return readLeaseFileTrimmed(join(leaseDir, "owner"));
}

async function readLeasePid(leaseDir: string): Promise<number | undefined> {
  const raw = await readLeaseFileTrimmed(join(leaseDir, "pid"));
  if (raw === undefined || !/^[1-9][0-9]*$/.test(raw)) return undefined;
  return Number(raw);
}

/** Read a lease file, trimmed; `undefined` when absent, blank, or the path is not
 * a directory (a poisoned non-dir lease path → both files unreadable → stale). */
async function readLeaseFileTrimmed(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, "utf8")).trim() || undefined;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw err;
  }
}

function issueLeaseDir(root: string, issue: number): string {
  return join(root, String(issue));
}

