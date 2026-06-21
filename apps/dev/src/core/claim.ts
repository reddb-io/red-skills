// Atomic GitHub-native claim substrate (ADR 0066, issue #622, PRD #614).
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
// Structure mirrors mirror.ts — three layers, the diff one pure:
//
//   marker      renderClaimComment(self) / parseClaimRecords(comments) — the wire
//     format. parseClaimRecords is garbage-tolerant: any comment that is not a
//     well-formed afk:claim marker is silently skipped, so arbitrary issue chatter
//     (and malformed/forged markers) never corrupts the decision.
//
//   reconciler  reconcileClaim(records, self, opts) — PURE. Given the parsed claim
//     records plus the claimant's own identity + comment id, returns won | lost
//     and the winner. No I/O. Liveness/staleness is injected via opts.isStale
//     (mirroring mirror.ts's `live` flag), so cross-host stale-claim recovery stays
//     a pure function of injected facts.
//
//   orchestrator  acquireClaim(gh, self, issue, opts) — the thin impure shell with
//     the GitHub client injected: post our claim → list claim markers → reconcile →
//     concede (best-effort) if we lost. The verdict is computed by the pure layer;
//     this layer only performs the side effects.
//
// Labels (`running` etc.) are no longer the lock. They remain an observability
// PROJECTION applied best-effort by the caller (process-issue) and are never
// consulted to arbitrate a winner.

import type { Runner } from "../types/runner.js";

/** Marker schema version. Bump only on an incompatible wire-format change so old
 * markers left on long-lived issues still parse (or are cleanly ignored). */
export const CLAIM_MARKER_VERSION = 1;

/** What a claimant is currently expressing. A `claim` contends for the issue; a
 * `concede` withdraws a prior claim (posted when a worker loses the race or
 * releases voluntarily). */
export type ClaimKind = "claim" | "concede";

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

export interface ClaimDecision {
  verdict: ClaimVerdict;
  /** The winning claimant's `worker` key, or null when no live claim contends
   * (only possible if `self` was not supplied to the reconciler — a usage error
   * the orchestrator never triggers). */
  winner: string | null;
  /** One-line rationale, for logs. */
  reason: string;
  /** Stale cross-host claimants this decision RECOVERED — workers whose latest
   * marker `isStale` rejected and who would otherwise have held an earlier claim
   * than the winner. Empty unless a stale claim was superseded. Drives the single
   * audit comment the orchestrator posts on a recovery (issue #627). */
  recovered: string[];
}

export interface ClaimReconcileOptions {
  /** Injected liveness/staleness predicate (mirrors mirror.ts's `live` flag). A
   * record for which this returns true is treated as a dead/expired claim and
   * does not contend — this is how a stale cross-host winner is recovered. Pure:
   * the caller computes staleness (TTL on createdAt, known-dead worker set, …)
   * and injects the verdict so the reconciler stays I/O-free. Defaults to "never
   * stale". */
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
 * AFK runner improvement: when `deathFor` is supplied, it resolves each
 * recovered owner's death cause (from its process-safety diagnostic log, when
 * same-host and readable). Any resolved causes are appended so the comment
 * SAYS why the predecessor died — "uncatchable death (likely SIGKILL/OOM) at
 * ~HH:MM" — instead of only "stopped refreshing". This is what makes the
 * Pattern 5 diagnostic actionable: the next worker's recovery comment carries
 * the forensic verdict. `deathFor` returning null (cross-host, no log, or
 * still-running) omits that owner's clause, so the comment degrades to the
 * original wording when nothing is known. */
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
  self: { worker: string; runner?: string; createdAt?: string },
  kind: ClaimKind = "claim",
): string {
  const fields = [
    `v${CLAIM_MARKER_VERSION}`,
    `worker=${escapeField(self.worker)}`,
    `kind=${kind}`,
  ];
  if (self.runner) fields.push(`runner=${escapeField(self.runner)}`);
  if (self.createdAt) fields.push(`ts=${escapeField(self.createdAt)}`);
  const marker = `${MARKER_OPEN} ${fields.join(" ")} -->`;
  const human =
    kind === "claim"
      ? `🤖 AFK claim by worker \`${self.worker}\`${self.runner ? ` (runner \`${self.runner}\`)` : ""}.`
      : `🤖 AFK worker \`${self.worker}\` conceded this issue (lost the claim race or released).`;
  return `${marker}\n${human}`;
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
      const fields = parseFields(m[1]);
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
    if (isStale(f.latestRecord)) {
      stale.push({ worker, claimId: f.earliestClaimId }); // dead/expired — recovered
      continue;
    }
    contenders.push({ worker, claimId: f.earliestClaimId });
  }

  if (contenders.length === 0) {
    return { verdict: "lost", winner: null, reason: "no live claim contends", recovered: [] };
  }

  contenders.sort((a, b) => a.claimId - b.claimId || (a.worker < b.worker ? -1 : 1));
  const winner = contenders[0];

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
}

export interface AcquireClaimOptions extends ClaimReconcileOptions {
  /** Skip posting the human-facing concede when we lose (kept for tests). */
  suppressConcede?: boolean;
  /**
   * AFK runner improvement: resolve a recovered stale-claim owner's death cause
   * for the recovery audit comment (Pattern 5 — make the diagnostic
   * actionable). Injected so claim.ts stays pure; the runtime binds it to
   * `deathCauseForRecoveredWorker`. Absent → the comment keeps its original
   * wording.
   */
  deathFor?: (recoveredWorker: string) => string | null;
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
  const raw = await gh.listClaims(issue);
  const records = parseClaimRecords(raw);
  const decision = reconcileClaim(records, { ...self, commentId }, opts);
  if (decision.verdict === "lost" && !opts.suppressConcede) {
    await gh.concede(
      issue,
      renderClaimComment({ worker: self.worker, runner: self.runner }, "concede"),
    );
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
