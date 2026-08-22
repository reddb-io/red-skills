// brief-contract — the executable-acceptance contract, in the one place every
// door that enforces it can reach (ADR 0154's brief-contract line, Spec #4129,
// Ticket #4139).
//
// The lint itself is old: it has scored issue bodies since the triage skill was
// written, and `/red-doctor` has reported on it. What it never did was REFUSE
// anything. A vague brief passed the doctor as a warning, reached
// `ready-for-agent`, and cost a Worker a whole workspace to discover that
// "make the thing better" is not a task. The lint was advice; this module is
// the same lint with a refusal channel, wired into three doors that can each
// say no before the next one is reached:
//
//   1. **Triage promotion** refuses to add `ready-for-agent` (host-side), with
//      the FULL machine-checkable judgement — the author is there to fix it.
//   2. **The native handoff decoder** refuses a Ticket whose brief carries no
//      acceptance criteria at all (structural only), so the Worker body never
//      enters its Ticket loop briefless.
//   3. **The Worker preflight** withdraws on the same structural check before
//      the claim marker exists, so a briefless Ticket is never owned by the
//      Worker that noticed.
//
// ## Why the lint lives HERE and not where it was born
//
// It was born in `apps/plugin-dev` (a runtime, the top of the dependency
// stack), which is exactly where a rule that must also bind the wire and the
// engine cannot live: `packages/protocol-acp` and `packages/worker` sit BELOW
// it, and the dependency-direction guard refuses the reach. A contract three
// layers enforce belongs at the layer all three can see. The runtime keeps its
// own surface — the recipe comment triage posts is triage's UX, not the
// contract — and re-exports the lint so its existing callers are unchanged.
//
// ## The rule, stated once
//
// A brief satisfies the contract when it carries an acceptance-criteria section
// whose checklist items are MACHINE-CHECKABLE: each item either names a direct
// artifact (a command, a test, a fixture, anything in backticks) or pairs an
// observable surface with a pinned behaviour. The judgement is deliberately
// coarse and deliberately permissive — a first cut that refuses half the
// backlog is a first cut somebody turns off — and it is PURE: text in, verdict
// out, no clock, no filesystem, no network.

/** The verdict on one brief: whether it passes, why not, and what it listed. */
export interface AcceptanceCriteriaLintResult {
  ok: boolean;
  reason: string;
  items: string[];
}

const ACCEPTANCE_HEADING_RE = /^\s*(?:#{1,6}\s+)?acceptance\s+criteria\s*:?\s*$/i;
const BOLD_ACCEPTANCE_HEADING_RE = /^\s*\*\*acceptance\s+criteria:?\*\*\s*$/i;
const NEXT_SECTION_RE = /^\s*(?:#{1,6}\s+\S|\*\*[^*]+:?\*\*\s*$)/;
const CHECKLIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.+?)\s*$/;

const DIRECT_ARTIFACT_PATTERNS = [
  /`[^`]+`/,
  /\b(?:pnpm|npm|yarn|bun|cargo|go test|pytest|vitest|jest|playwright|make|gh|curl)\b/i,
  /\b(?:test|tests|fixture|fixtures|snapshot|assert|expect|regression|reproduction|command|workflow)\b/i,
];

const OBSERVABLE_SURFACE_RE =
  /\b(?:artifact|behavior|body|branch|comment|exit code|field|file|issue|label|output|pr|request|response|route|state|status|stderr|stdout|url|workflow)\b/i;

const PINNED_BEHAVIOR_RE =
  /\b(?:at least|at most|blocks?|contains?|does not|emits?|equals?|exactly|exits?|fails?|idempotent|leaves?|machine-checkable|no duplicate|only one|prints?|receives?|rejects?|remains?|returns?|routes?|same observable|stays?|without|with no)\b/i;

/**
 * Lint one brief for executable acceptance criteria. PURE.
 *
 * Fails FAST and names the first offending item verbatim, because a refusal
 * that says "some item is vague" sends the reader back to re-derive which one.
 */
export function lintExecutableAcceptanceCriteria(body: string): AcceptanceCriteriaLintResult {
  const section = acceptanceCriteriaSection(body);
  if (section === undefined) {
    return { ok: false, reason: "missing acceptance-criteria section", items: [] };
  }

  const items = extractChecklistItems(section);
  if (items.length === 0) {
    return { ok: false, reason: "acceptance-criteria section has no checklist items", items };
  }

  for (const item of items) {
    if (!isMachineCheckable(item)) {
      return {
        ok: false,
        reason: `acceptance criteria item is not machine-checkable: ${item}`,
        items,
      };
    }
  }

  return { ok: true, reason: "ok", items };
}

/**
 * The one prefix every brief-contract refusal wears, at every door.
 *
 * A shared prefix is what lets an operator grep one string and find the refusal
 * whether it came from triage, from the decoder or from the preflight — three
 * spellings of one rule are three rules as far as a search is concerned.
 */
export const BRIEF_CONTRACT_REFUSAL_PREFIX = "brief contract refused";

/**
 * The refusal one brief earns, or `null` when it satisfies the contract. PURE.
 *
 * The lint's finding travels VERBATIM: the whole point of refusing at a door is
 * that whoever is sent back knows which item to fix, and a refusal that
 * paraphrases the lint is a refusal the next reader has to re-run the lint to
 * act on.
 */
export function briefContractRefusal(brief: string): string | null {
  const lint = lintExecutableAcceptanceCriteria(brief);
  return lint.ok ? null : `${BRIEF_CONTRACT_REFUSAL_PREFIX}: ${lint.reason}`;
}

/**
 * The STRUCTURAL refusal one brief earns at an execution door, or `null`. PURE.
 *
 * The execution doors — the handoff decoder and the Worker preflight — check
 * only that an acceptance-criteria section exists and lists at least one item.
 * The machine-checkable judgement stays at triage promotion, where the author
 * is present to fix the sentence; enforced at the wire it judged 41 of 42 live
 * briefs too vague and turned every drain into a birth-and-refuse loop
 * (#4296's grinder wearing the contract's own uniform). A door that refuses
 * the whole backlog is a door somebody turns off — this one refuses only what
 * no Validation could ever read: a brief with no criteria at all.
 */
export function briefContractStructuralRefusal(brief: string): string | null {
  const lint = lintExecutableAcceptanceCriteria(brief);
  if (lint.ok) return null;
  if (lint.items.length > 0) return null;
  return `${BRIEF_CONTRACT_REFUSAL_PREFIX}: ${lint.reason}`;
}

function acceptanceCriteriaSection(body: string): string | undefined {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => ACCEPTANCE_HEADING_RE.test(line) || BOLD_ACCEPTANCE_HEADING_RE.test(line));
  if (start < 0) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => NEXT_SECTION_RE.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

function extractChecklistItems(section: string): string[] {
  return section
    .split(/\r?\n/)
    .map((line) => CHECKLIST_ITEM_RE.exec(line)?.[1]?.trim())
    .filter((item): item is string => Boolean(item));
}

function isMachineCheckable(item: string): boolean {
  if (DIRECT_ARTIFACT_PATTERNS.some((pattern) => pattern.test(item))) return true;
  return OBSERVABLE_SURFACE_RE.test(item) && PINNED_BEHAVIOR_RE.test(item);
}
