// boot-sweep — boot-time decision logic for two /afk startup phases:
// the Unblock Sweep and the Straggler Check (afk.sh sweep_unblocked /
// straggler_check; SKILL.md "Unblock Sweep" / "Straggler Check").
//
// UNBLOCK SWEEP: for every open issue labelled `blocked:dependency`, resolve
// its `req:*` dependency edges and promote it to `ready-for-agent` ONLY when
// every referenced blocker is CLOSED. For pre-`req:*` dependency issues, the
// sweep can fall back to refs under a literal `## Blocked by` heading, but only
// while the issue is still explicitly marked `blocked:dependency`. Plain
// `ready-for-human` issues are HITL/spec gates and must never be reanimated just
// because an informational blocker issue closed.
//
// STRAGGLER CHECK: count open issues in states /afk cannot consume (unlabeled,
// needs-triage, needs-info); warn (and on a TTY prompt) when any is non-zero.
//
// All decision logic is PURE: every gh lookup is injected so the deciders
// perform no gh/git/network I/O. Mirrors the bash extraction and promote rule
// exactly:
//
//   refs="$(awk '/^## Blocked by[[:space:]]*$/{flag=1; next} /^## /{flag=0} flag' \
//            | { grep -oE '#[0-9]+' || true; } | sort -u)"
//
// i.e. take every line strictly after the literal `## Blocked by` heading up to
// (but not including) the next `## ` heading, scrape every `#<digits>` token off
// those lines, then sort -u (lexical, deduplicated).

/** The literal `## Blocked by` heading line, allowing only trailing whitespace.
 * Mirrors awk `/^## Blocked by[[:space:]]*$/`. */
import { LABEL_STALLED, LABEL_CRASHED, LABEL_MERGE_CONFLICT, LABEL_DEPENDENCY, LABEL_READY, LABEL_RUNNING, LABEL_HUMAN } from "./triage-labels.js";
import { hostHitlTypesIn, isRefused, planTransition } from "./state-transition.js";
import {
  renderIssueReferenceList,
  resolveIssueReferences,
  type IssueReferenceLookup,
} from "./issue-reference.js";

const BLOCKED_BY_HEADING_RE = /^## Blocked by[ \t]*$/;
/** Any `## ` heading — the awk `/^## /` that closes the Blocked-by section. */
const ANY_H2_RE = /^## /;
/** `#<digits>` token scraper. Mirrors `grep -oE '#[0-9]+'` (global). */
const REF_TOKEN_RE = /#[0-9]+/g;

/**
 * Extract the blocker refs (`#N` strings) declared under the literal
 * `## Blocked by` heading in `body`, sorted-unique exactly as the bash pipeline
 * (`awk … | grep -oE '#[0-9]+' | sort -u`) produces them.
 *
 * - Lines collected: every line strictly after the `## Blocked by` heading line,
 *   up to but not including the next `## ` heading. The heading line itself is
 *   skipped (awk `next`).
 * - Tokens: every `#<digits>` occurrence on those lines, in textual form
 *   (e.g. `"#123"`). Checkbox shape is irrelevant — `- [ ] #1` and a bare `#1`
 *   both contribute `#1`.
 * - Ordering: lexical sort with duplicates removed (`sort -u`), so `#10` sorts
 *   before `#2`. No `## Blocked by` section, or an empty one, yields `[]`.
 */
export function parseBlockedBy(body: string): string[] {
  let inSection = false;
  const seen = new Set<string>();
  for (const line of body.split("\n")) {
    if (inSection) {
      if (ANY_H2_RE.test(line)) {
        inSection = false;
        continue;
      }
      const matches = line.match(REF_TOKEN_RE);
      if (matches) for (const m of matches) seen.add(m);
      continue;
    }
    if (BLOCKED_BY_HEADING_RE.test(line)) inSection = true;
  }
  return [...seen].sort();
}

/** Normalise a ref token (`"#123"` or `"123"`) to its numeric id, or `null`. */
export function refToNumber(ref: string): number | null {
  const m = /^#?([0-9]+)$/.exec(ref.trim());
  return m ? Number(m[1]) : null;
}

/** A `req:<N>` dependency label — the queryable edge that mirrors `spec:<N>`. An
 * issue carrying `req:101` declares it "requires #101 to close before it can be
 * worked"; multiple `req:*` labels stack (req:101, req:102, …). */
const REQ_LABEL_RE = /^req:([0-9]+)$/;

/**
 * Extract the dependency issue numbers from a label set: each `req:<N>` label
 * contributes `N`. Non-numeric (`req:foo`) and non-`req:` labels are ignored.
 * The result is sorted-unique ascending NUMERICALLY (so #2 before #10) — these
 * are real ids, not the lexical `## Blocked by` ref tokens. Pure.
 */
export function parseReqLabels(labels: readonly string[]): number[] {
  const seen = new Set<number>();
  for (const label of labels) {
    const m = REQ_LABEL_RE.exec(label.trim());
    if (m) seen.add(Number(m[1]));
  }
  return [...seen].sort((a, b) => a - b);
}

/** The S1 blocker-state vocabulary the promote rule consumes. CLOSED maps to
 * the literal `gh issue view --json state --jq .state` value; everything else
 * (OPEN, a 404, or a transient gh failure) is "not closed". */
export type BlockerState = "CLOSED" | "open-or-unknown";

/**
 * Promote rule: true iff there is at least one blocker AND every blocker is
 * CLOSED. Mirrors the bash `all_closed` flag: it starts at 1, the loop flips it
 * to 0 on the first non-CLOSED ref, and the `[[ -z "$refs" ]] && continue`
 * guard means an empty ref set never reaches the promotion branch.
 */
export function shouldPromote(blockerStates: readonly BlockerState[]): boolean {
  if (blockerStates.length === 0) return false;
  return blockerStates.every((s) => s === "CLOSED");
}

/** Build the audit comment posted on promotion. Mirrors the SKILL.md contract
 * `🤖 /afk promoted to ready-for-agent: all blockers closed (#X, #Y).` — the
 * refs are joined with `, ` in their sorted-unique order. */
export function auditComment(refs: readonly string[]): string {
  return `🤖 /afk promoted to ready-for-agent: all blockers closed (${refs.join(", ")}).`;
}

/** Build the audit comment posted when an issue's `req:*` dependencies all
 * close. The now-satisfied deps are named as `#N` tokens in ascending order,
 * e.g. `🤖 /afk unblocked: all dependencies closed (#101, #102).` */
export function cascadeAuditComment(reqs: readonly number[]): string {
  return `🤖 /afk unblocked: all dependencies closed (${reqs.map((n) => `#${n}`).join(", ")}).`;
}

export async function cascadeAuditCommentFor(
  reqs: readonly number[],
  lookup?: IssueReferenceLookup,
): Promise<string> {
  const refs = await resolveIssueReferences(reqs, lookup);
  return `🤖 /afk unblocked: all dependencies closed (${renderIssueReferenceList(reqs.map((n) => refs.get(n) ?? { number: n }))}).`;
}

/** A dependent issue (carrying `req:*` labels) re-evaluated by the close
 * cascade: its number plus each declared dependency's number and closed-state. */
export interface DependentIssue {
  number: number;
  /** One entry per `req:<n>` label, with `n` resolved to its closed-state. */
  reqs: { n: number; closed: boolean }[];
  /** Full label set, read to decide the promotion LANE (#2966). Optional for
   * back-compat with callers that only resolved the dependency edges. */
  labels?: string[];
}

/** Which queue a promotion routes to: the autonomous `ready-for-agent` pool, or
 * the `ready-for-human` park a HUMAN-ONLY type demands (#2966). */
export type PromotionLane = "agent" | "human";

/**
 * The lane sentence appended to a promotion's audit comment, so a human reading
 * the Ticket can tell a sweep promotion from a hand-set label AND see why it
 * landed where it did. Empty when the repo declares no HUMAN-ONLY type — there
 * is no routing decision to explain, and such a repo's comments stay exactly as
 * they were before this rule existed. Pure.
 */
export function promotionLaneNote(
  lane: PromotionLane,
  carried: readonly string[],
  declared: readonly string[],
): string {
  if (declared.length === 0) return "";
  if (lane === "human") {
    return (
      ` Routed to \`${LABEL_HUMAN}\`: this Ticket carries ${carried.join(", ")}, declared` +
      ` HUMAN-ONLY in this repo's label vocabulary — a human owns the next move, and the` +
      ` agent never stands in for their side of it.`
    );
  }
  return ` Routed to \`${LABEL_READY}\`: this Ticket carries no HUMAN-ONLY type.`;
}

/**
 * Plan the event-driven close cascade triggered when `closedIssue` closes. For
 * each dependent issue carrying `req:closedIssue` (and possibly other `req:*`
 * deps), promote it IFF EVERY one of its `req:*` deps is now CLOSED (and it has
 * ≥1 dep) — the same all-closed semantics as `shouldPromote`. The LANE follows
 * the dependent's type: a Ticket carrying one of `hitlTypes` routes to
 * `ready-for-human`, everything else to `ready-for-agent` (#2966). The audit
 * comment names every now-satisfied dep in ascending order. `refs` holds the dep
 * ids as `#N` strings for parity with the sweep's PromotionPlan. Pure —
 * closed-states are resolved by the caller.
 */
export function planCloseCascade(
  closedIssue: number,
  dependents: readonly DependentIssue[],
  hitlTypes: readonly string[] = [],
): PromotionPlan[] {
  const plans: PromotionPlan[] = [];
  for (const dep of dependents) {
    const states: BlockerState[] = dep.reqs.map((r) => (r.closed ? "CLOSED" : "open-or-unknown"));
    if (!shouldPromote(states)) continue;
    const reqs = dep.reqs.map((r) => r.n).sort((a, b) => a - b);
    const carried = hostHitlTypesIn(dep.labels ?? [], hitlTypes);
    const lane: PromotionLane = carried.length > 0 ? "human" : "agent";
    plans.push({
      number: dep.number,
      refs: reqs.map((n) => `#${n}`),
      reqLabels: reqs.map((n) => `req:${n}`),
      comment: cascadeAuditComment(reqs) + promotionLaneNote(lane, carried, hitlTypes),
      lane,
      hitlTypes: carried,
    });
  }
  return plans;
}

/** A candidate the boot sweep examines: its number, raw body, and label set.
 * When `labels` carries `req:*` deps the sweep keys off those; the `## Blocked
 * by` body parse is the documented fallback only for `blocked:dependency`
 * issues that predate the req:N convention. */
export interface UnblockCandidate {
  number: number;
  body: string;
  /** Full label set, used to read `req:*` deps. Optional for back-compat with
   * callers that only know the body (legacy `## Blocked by` parse). */
  labels?: string[];
}

/** Issue-state lookup, injected so the sweep stays pure. Given a blocker issue
 * number, return its raw `gh` state string ("OPEN" | "CLOSED"), or `undefined`
 * for a 404 / transient gh failure (treated as not-closed, matching bash where
 * a failed `gh issue view` yields an empty `r_state` that is `!= CLOSED`). */
export type BlockerStateLookup = (issue: number) => Promise<string | undefined>;

/** One planned promotion: the issue to flip plus its audit comment. */
export interface PromotionPlan {
  /** The dependency-blocked issue to promote to `ready-for-agent`. */
  number: number;
  /** The sorted-unique blocker refs that resolved to CLOSED. */
  refs: string[];
  /** The `req:<N>` label names to remove on promotion (mirrors `refs` as labels).
   * Empty for legacy `## Blocked by` promotions that carried no `req:*` labels. */
  reqLabels: string[];
  /** The audit comment to post on promotion. */
  comment: string;
  /** Which queue this promotion routes to (#2966). `human` whenever the Ticket
   * carries a type the repo's vocabulary declares HUMAN-ONLY. */
  lane: PromotionLane;
  /** The declared HUMAN-ONLY type labels the Ticket carries — the reason the
   * lane is `human`, named in the audit comment. Empty for the agent lane. */
  hitlTypes: string[];
}

/**
 * Plan the Unblock Sweep over `candidates`. For each candidate the sweep PREFERS
 * the structured `req:*` labels (the queryable dependency edge): when the
 * candidate carries ≥1 `req:<N>` label, the deps are those N, each looked up via
 * `fetchBlockerState`, and a promotion is planned only when EVERY one is CLOSED
 * — the audit comment then uses the `cascadeAuditComment` "all dependencies
 * closed" wording. When the candidate carries NO `req:*` label but is explicitly
 * labelled `blocked:dependency`, the sweep FALLS BACK to the legacy `## Blocked
 * by` body parse for old dependency issues. Plain `ready-for-human` issues do
 * not use the fallback; that state means a human gate, not dependency-wait.
 * Candidates with neither are skipped (bash `[[ -z "$refs" ]] && continue`).
 *
 * Pure modulo the injected lookup: no gh/git/network I/O happens here.
 */
export async function planUnblockSweep(
  candidates: readonly UnblockCandidate[],
  fetchBlockerState: BlockerStateLookup,
  hitlTypes: readonly string[] = [],
): Promise<PromotionPlan[]> {
  const plans: PromotionPlan[] = [];
  for (const candidate of candidates) {
    const labels = candidate.labels ?? [];
    if (!labels.includes(LABEL_DEPENDENCY)) continue;

    const reqIds = parseReqLabels(labels);
    // The LANE is the candidate's own type, not the sweep's default (#2966):
    // blockers closing frees a HUMAN-ONLY Ticket for its human, never for an agent.
    const carried = hostHitlTypesIn(labels, hitlTypes);
    const lane: PromotionLane = carried.length > 0 ? "human" : "agent";

    // Prefer the structured req:* dependency labels when present.
    if (reqIds.length > 0) {
      const states: BlockerState[] = [];
      for (const id of reqIds) {
        const raw = await fetchBlockerState(id);
        states.push(raw === "CLOSED" ? "CLOSED" : "open-or-unknown");
      }
      if (shouldPromote(states)) {
        plans.push({
          number: candidate.number,
          refs: reqIds.map((n) => `#${n}`),
          reqLabels: reqIds.map((n) => `req:${n}`),
          comment: cascadeAuditComment(reqIds) + promotionLaneNote(lane, carried, hitlTypes),
          lane,
          hitlTypes: carried,
        });
      }
      continue;
    }

    // Legacy fallback: the `## Blocked by` body parse, restricted to issues
    // whose label state still says "dependency wait".
    const refs = parseBlockedBy(candidate.body);
    if (refs.length === 0) continue;

    const states: BlockerState[] = [];
    for (const ref of refs) {
      const id = refToNumber(ref);
      const raw = id === null ? undefined : await fetchBlockerState(id);
      states.push(raw === "CLOSED" ? "CLOSED" : "open-or-unknown");
    }

    if (shouldPromote(states)) {
      plans.push({
        number: candidate.number,
        refs,
        reqLabels: [],
        comment: auditComment(refs) + promotionLaneNote(lane, carried, hitlTypes),
        lane,
        hitlTypes: carried,
      });
    }
  }
  return plans;
}

/** The minimal gh surface the Unblock Sweep MUTATES: rotate labels + post the
 * audit comment. Injected so the promote loop lives in exactly one place — both
 * the boot-time sweep and the periodic supervisor sweep (#844) call
 * {@link executeUnblockSweep} through it. */
export interface UnblockSweepGh {
  /** Rotate labels — REMOVE first, ADD second (BootDeps.gh order). */
  editLabels(issue: number, remove: string[], add: string[]): Promise<void>;
  comment(issue: number, body: string): Promise<void>;
  /** Optional human-facing metadata lookup for rendered dependency refs. */
  issueReference?(issue: number): Promise<{ number: number; title?: string; url?: string } | undefined>;
}

/**
 * Run the Unblock Sweep end-to-end: {@link planUnblockSweep} the candidates,
 * then promote each planned issue — strip its holding `blocked:dependency` label
 * (the defensive `ready-for-human` fallback only fires for a malformed candidate
 * the planner would never plan) and add `ready-for-agent`, then post the audit
 * comment. Returns the promoted issue numbers.
 *
 * This is the SINGLE mutation path for the sweep. The boot-time safety net and
 * the periodic supervisor tick (#844) both call it so a missed live close-cascade
 * self-heals identically from either trigger. Idempotent: a candidate with an
 * still-open `req:*` is left blocked; a fully-unblocked one is promoted exactly
 * once (the next sweep no longer sees it, since the promotion drops the
 * `blocked:dependency` label that put it in the candidate set).
 */
export async function executeUnblockSweep(
  candidates: readonly UnblockCandidate[],
  fetchBlockerState: BlockerStateLookup,
  gh: UnblockSweepGh,
  hitlTypes: readonly string[] = [],
): Promise<number[]> {
  const plans = await planUnblockSweep(candidates, fetchBlockerState, hitlTypes);
  // Resolve each promoted issue's holding label from its candidate label set.
  const labelsByIssue = new Map<number, string[]>();
  for (const c of candidates) labelsByIssue.set(c.number, c.labels ?? []);
  const promoted: number[] = [];
  for (const p of plans) {
    const held = labelsByIssue.get(p.number) ?? [];
    // Promote through the ADR 0122 transition API (#2528) when the candidate's
    // labels were listed: one atomic edit that consumes every req:* edge and
    // provably leaves exactly one state role. The legacy edit survives only for
    // a label-less candidate (degraded listing), where no plan can be proven.
    const plan = held.length > 0 ? planTransition(held, { kind: "promote" }, hitlTypes) : undefined;
    if (plan && !isRefused(plan)) {
      await gh.editLabels(p.number, [...plan.remove], [...plan.add]);
    } else if (plan && isRefused(plan)) {
      continue;
    } else {
      const remove = held.includes(LABEL_DEPENDENCY) ? LABEL_DEPENDENCY : LABEL_HUMAN;
      await gh.editLabels(
        p.number,
        [remove, ...p.reqLabels],
        [p.lane === "human" ? LABEL_HUMAN : LABEL_READY],
      );
    }
    const reqs = p.refs.map(refToNumber).filter((n): n is number => n !== null);
    const comment = p.reqLabels.length > 0 && reqs.length > 0
      ? (await cascadeAuditCommentFor(reqs, gh.issueReference)) +
        promotionLaneNote(p.lane, p.hitlTypes, hitlTypes)
      : p.comment;
    await gh.comment(p.number, comment);
    promoted.push(p.number);
  }
  return promoted;
}

/** Counts of open issues in states /afk cannot consume. Mirrors the three
 * `gh issue list … --jq length` probes the straggler check runs. */
export interface StragglerCounts {
  unlabeled: number;
  needsTriage: number;
  needsInfo: number;
}

/** Injected per-state count lookup so `stragglerCounts` stays pure. Each call
 * returns the count for one straggler bucket (a failed gh probe defaults to 0,
 * matching the bash `|| echo 0`). */
export interface StragglerCountLookup {
  unlabeled: () => Promise<number>;
  needsTriage: () => Promise<number>;
  needsInfo: () => Promise<number>;
}

/** Gather the three straggler counts via the injected lookups. A non-finite or
 * negative result is clamped to 0, mirroring the bash `|| echo 0` fallback. */
export async function stragglerCounts(lookup: StragglerCountLookup): Promise<StragglerCounts> {
  const clamp = (n: number) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
  return {
    unlabeled: clamp(await lookup.unlabeled()),
    needsTriage: clamp(await lookup.needsTriage()),
    needsInfo: clamp(await lookup.needsInfo()),
  };
}

/** Warn iff any straggler bucket is non-zero. Mirrors the bash guard
 * `[[ $unlabeled -gt 0 || $needs_triage -gt 0 || $needs_info -gt 0 ]]`. */
export function shouldWarnStragglers(counts: StragglerCounts): boolean {
  return counts.unlabeled > 0 || counts.needsTriage > 0 || counts.needsInfo > 0;
}

// ---------- mixed-blocked normalizer (#1481) ----------

/** A candidate the mixed-blocked normalizer examines: number + full label set. */
export interface MixedBlockedCandidate {
  number: number;
  labels: string[];
}

/** One planned heal: strip the stale `blocked:*` labels off a queued/active issue
 * so it can never trip a worker's lifecycle FSM into the illegal state. */
export interface MixedBlockedNormalizePlan {
  number: number;
  /** The `blocked:*` labels to remove (sorted-unique). */
  remove: string[];
}

/**
 * Plan the mixed-blocked normalizer over `candidates`. An issue is MIXED-BLOCKED
 * when it carries a queued/active label (`ready-for-agent` or `running`) TOGETHER
 * with one or more `blocked:*` labels — the illegal FSM state that crashed workers
 * mid-setup before #1481. The heal is to shed every `blocked:*` label, restoring a
 * clean queued/active state. Issues that are cleanly queued (no blocked:*), cleanly
 * blocked (no ready/running), or otherwise legal produce no plan. Pure and
 * idempotent: a healed issue no longer matches, so a replay no-ops.
 */
export function planMixedBlockedNormalize(
  candidates: readonly MixedBlockedCandidate[],
): MixedBlockedNormalizePlan[] {
  const plans: MixedBlockedNormalizePlan[] = [];
  for (const c of candidates) {
    const queuedOrActive = c.labels.includes(LABEL_READY) || c.labels.includes(LABEL_RUNNING);
    if (!queuedOrActive) continue;
    const blocked = [...new Set(c.labels.filter((l) => l.startsWith("blocked:")))].sort();
    if (blocked.length === 0) continue;
    plans.push({ number: c.number, remove: blocked });
  }
  return plans;
}

/** The minimal gh surface the normalizer MUTATES: strip the stale blocked:* labels
 * (REMOVE first, ADD second — BootDeps.gh order). */
export interface MixedBlockedNormalizeGh {
  editLabels(issue: number, remove: string[], add: string[]): Promise<void>;
}

/**
 * Run the mixed-blocked normalizer end-to-end: {@link planMixedBlockedNormalize}
 * the candidates, then strip each planned issue's stale `blocked:*` labels in one
 * edit. Returns the healed issue numbers. Best-effort: a failed edit skips that
 * issue and leaves it for the next sweep — a normalizer must never abort the boot.
 */
export async function executeMixedBlockedNormalize(
  candidates: readonly MixedBlockedCandidate[],
  gh: MixedBlockedNormalizeGh,
): Promise<number[]> {
  const plans = planMixedBlockedNormalize(candidates);
  const healed: number[] = [];
  for (const p of plans) {
    try {
      await gh.editLabels(p.number, p.remove, []);
      healed.push(p.number);
    } catch {
      // Best-effort: a failed heal leaves the issue for the next boot's sweep.
    }
  }
  return healed;
}

// ---------- reconcile sweep ----------

/** Pattern for deterministic `afk/{N}-{slug}` and legacy
 * `afk/{worker}/{N}-{slug}` branches. Mirrors branch-cleanup.ts. */
const AFK_LIVE_BRANCH_RE = /^afk\/(?:([0-9]+)-[a-z0-9-]+|[A-Za-z0-9._-]+\/([0-9]+)-[a-z0-9-]+)$/;

/**
 * Extract the issue number from an `afk/{worker}/{N}-{slug}` live-iteration
 * branch ref. Returns null when the ref does not match the pattern (e.g.
 * `afk-attempts/*` or a malformed ref). Pure.
 */
export function issueFromAFKBranch(branch: string): number | null {
  const m = AFK_LIVE_BRANCH_RE.exec(branch);
  return m ? Number(m[1] ?? m[2]) : null;
}

/**
 * Find the first `afk/{worker}/{issue}-{slug}` branch in `branches` that owns
 * `issue`. The caller passes the remote live-iteration branch list (e.g. from
 * `git ls-remote --heads origin afk/`). Returns null when no matching branch is
 * present — the sweep skips this issue. Pure.
 */
export function findOwnedBranch(branches: readonly string[], issue: number): string | null {
  for (const b of branches) {
    if (issueFromAFKBranch(b) === issue) return b;
  }
  return null;
}

/** The labels that mark a parked-mechanical issue the reconcile sweep can pick
 * up: the attempt-progress guard fired (`blocked:stalled`), the agent process
 * crashed (`blocked:crashed`), or a land-time trunk conflict parked the branch
 * (`blocked:merge-conflict`, issue #1095). All three carry a branch that may
 * simply need re-landing on fresh trunk — never a human decision. */
const PARKED_MECHANICAL_LABELS = new Set([LABEL_STALLED, LABEL_CRASHED, LABEL_MERGE_CONFLICT]);

/**
 * True when the label set carries a parked-mechanical routing label. Pure.
 */
export function isParkedMechanical(labels: readonly string[]): boolean {
  return labels.some((l) => PARKED_MECHANICAL_LABELS.has(l));
}

/** A parked-mechanical candidate the reconcile sweep examines. */
export interface ReconcileSweepCandidate {
  number: number;
  title: string;
  body: string;
  labels: string[];
}

/** One planned reconcile: the candidate plus the owned branch to validate-and-land. */
export interface ReconcileSweepPlan {
  number: number;
  title: string;
  body: string;
  labels: string[];
  /** The `afk/{worker}/{N}-{slug}` ref on origin that carries this issue's work. */
  branch: string;
}

/**
 * Plan the reconcile sweep: for each parked-mechanical candidate that has an
 * `afk/{worker}/{N}-{slug}` branch on origin, produce a reconcile plan. Issues
 * without a parked-mechanical label are skipped; issues with a branch but also a
 * `blocked:spec` / `blocked:validation` label (or an active non-mechanical
 * `## Current blocker`) are rejected by `reconcile()`'s own guard — the
 * planner's only job is the ownership check. Pure.
 *
 * @param candidates - Open issues labelled `blocked:stalled` or `blocked:crashed`.
 * @param remoteBranches - The `afk/{worker}/{N}-{slug}` live branches on origin
 *   (one short-name per element, e.g. `["afk/wA1B5/101-add-feature"]`).
 */
export function planReconcileSweep(
  candidates: readonly ReconcileSweepCandidate[],
  remoteBranches: readonly string[],
  staleReleasedRunningIssues: readonly number[] = [],
): ReconcileSweepPlan[] {
  const plans: ReconcileSweepPlan[] = [];
  const releasedRunning = new Set(staleReleasedRunningIssues);
  for (const c of candidates) {
    const staleReleasedRunning = c.labels.includes(LABEL_RUNNING) && releasedRunning.has(c.number);
    if (!isParkedMechanical(c.labels) && !staleReleasedRunning) continue;
    const branch = findOwnedBranch(remoteBranches, c.number);
    if (!branch) continue;
    plans.push({ number: c.number, title: c.title, body: c.body, labels: c.labels, branch });
  }
  return plans;
}
