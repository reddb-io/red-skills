// boot-sweep — boot-time decision logic for two /afk startup phases:
// the Unblock Sweep and the Straggler Check (afk.sh sweep_unblocked /
// straggler_check; SKILL.md "Unblock Sweep" / "Straggler Check").
//
// UNBLOCK SWEEP: for every open issue labelled `ready-for-human`, extract the
// `#N` blocker refs under the literal `## Blocked by` heading in the body and
// look up each blocker's state. Promote the issue back to `ready-for-agent`
// (remove ready-for-human, add ready-for-agent, post an audit comment) ONLY
// when EVERY referenced blocker is CLOSED. The GitHub task-list checkbox state
// (`- [ ] #N` / `- [x] #N`) in the body is human UX — the injected state lookup
// is the source of truth.
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

/** A `ready-for-human` candidate the sweep examines: its number and raw body. */
export interface UnblockCandidate {
  number: number;
  body: string;
}

/** Issue-state lookup, injected so the sweep stays pure. Given a blocker issue
 * number, return its raw `gh` state string ("OPEN" | "CLOSED"), or `undefined`
 * for a 404 / transient gh failure (treated as not-closed, matching bash where
 * a failed `gh issue view` yields an empty `r_state` that is `!= CLOSED`). */
export type BlockerStateLookup = (issue: number) => Promise<string | undefined>;

/** One planned promotion: the issue to flip plus its audit comment. */
export interface PromotionPlan {
  /** The `ready-for-human` issue to promote to `ready-for-agent`. */
  number: number;
  /** The sorted-unique blocker refs that resolved to CLOSED. */
  refs: string[];
  /** The audit comment to post on promotion. */
  comment: string;
}

/**
 * Plan the Unblock Sweep over `candidates`. For each candidate, parse its
 * `## Blocked by` refs, look up each referenced blocker's state via
 * `fetchBlockerState`, and emit a promotion plan only when every ref is CLOSED
 * (and there is at least one ref). Candidates with no refs are skipped, exactly
 * as the bash `[[ -z "$refs" ]] && continue`.
 *
 * Pure modulo the injected lookup: no gh/git/network I/O happens here.
 */
export async function planUnblockSweep(
  candidates: readonly UnblockCandidate[],
  fetchBlockerState: BlockerStateLookup,
): Promise<PromotionPlan[]> {
  const plans: PromotionPlan[] = [];
  for (const candidate of candidates) {
    const refs = parseBlockedBy(candidate.body);
    if (refs.length === 0) continue;

    const states: BlockerState[] = [];
    for (const ref of refs) {
      const id = refToNumber(ref);
      const raw = id === null ? undefined : await fetchBlockerState(id);
      states.push(raw === "CLOSED" ? "CLOSED" : "open-or-unknown");
    }

    if (shouldPromote(states)) {
      plans.push({ number: candidate.number, refs, comment: auditComment(refs) });
    }
  }
  return plans;
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
