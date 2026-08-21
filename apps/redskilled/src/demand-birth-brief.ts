/**
 * demand-birth-brief — whether a planned birth can be briefed, and what is missing.
 *
 * **A birth the daemon cannot brief is a birth it does not perform** (#4292).
 * A Worker enters its Ticket loop only through a handoff; without one the body
 * takes its third path — echo the prompt back and end the turn — so the item it
 * was born for stays queued and the planner asks for another on the next tick.
 * Observed live as 58 Workers in ~15 minutes, each paying a worktree clone and a
 * host slot to answer `no-workflow-outcome (end_turn)`.
 *
 * `demandTurnForBirth` already decided this, and collapsed it to a boolean: the
 * handoff was simply omitted, and the caller could not tell an unbriefable birth
 * from a deliberately prompt-only one. The decision lives here instead, stating
 * WHICH fact is absent, so the lifecycle refuses the birth and an operator reads
 * the missing fact rather than a Worker's echo. PURE — no daemon, no clock, no
 * socket; the lifecycle wires one call and the test needs neither.
 */

/** The one fact whose absence makes a birth unbriefable. */
export type DemandBriefGap =
  | "count-only-poll"
  | "no-ticket"
  | "unusable-number"
  | "empty-title"
  | "no-trunk-branch";

/** What one planned birth's brief came to. PURE. */
export interface DemandBriefVerdict {
  readonly briefed: boolean;
  /** The absent fact, when there is one; never set on a briefed verdict. */
  readonly gap?: DemandBriefGap;
}

/** One project as the last poll left it, in the facts a brief is built from. */
export interface DemandBriefPoll {
  readonly project_label: string;
  /**
   * Whether that poll LISTED what it counted, stated rather than inferred.
   *
   * A route that counts without listing carries no `tickets`, and an absent
   * field reads exactly like a project whose queue drained — which is how a
   * count-only poll came to plan births nothing could brief.
   */
  readonly briefing?: "listed" | "count-only";
  readonly tickets?: readonly { readonly id: string; readonly title: string; readonly labels: readonly string[] }[];
}

/**
 * What the last poll knows about the item a birth is for. PURE.
 *
 * Beside the verdict it feeds rather than in the demand loop: the lifecycle
 * decides that a birth happens, never what the Worker is told about it.
 */
export function queueBriefing(
  projects: readonly DemandBriefPoll[],
  projectLabel: string,
  workItem: string | undefined,
): { readonly id: string; readonly title: string; readonly labels: readonly string[] } | undefined {
  if (workItem == null) return undefined;
  return projects.find((project) => project.project_label === projectLabel)
    ?.tickets?.find((candidate) => candidate.id === workItem);
}

/**
 * Whether this birth can state a Ticket handoff, and which fact stops it. PURE.
 *
 * Every fact the handoff requires is checked in the order an operator would ask
 * about it: what the poll could say, then what it said about this item, then
 * what the registration says about the trunk to branch from.
 */
export function demandBriefVerdict(
  registration: { readonly trunk?: { readonly branch: string } } | undefined,
  ticket: { readonly id: string; readonly title: string } | undefined,
  poll?: DemandBriefPoll,
): DemandBriefVerdict {
  if (ticket == null) {
    return { briefed: false, gap: poll?.briefing === "count-only" ? "count-only-poll" : "no-ticket" };
  }
  const number = Number(ticket.id);
  if (!Number.isInteger(number) || number <= 0) return { briefed: false, gap: "unusable-number" };
  if (ticket.title === "") return { briefed: false, gap: "empty-title" };
  const base = registration?.trunk?.branch;
  if (base == null || base === "") return { briefed: false, gap: "no-trunk-branch" };
  return { briefed: true };
}

/** Why one absent fact stops a brief, in the words an operator reads. PURE. */
export function describeDemandBriefGap(gap: DemandBriefGap): string {
  switch (gap) {
    case "count-only-poll":
      return "the last queue poll counted this project without listing it, so it holds no Ticket to hand over";
    case "no-ticket":
      return "the last queue poll listed no Ticket for that item";
    case "unusable-number":
      return "the Ticket the last poll listed carries no usable number";
    case "empty-title":
      return "the Ticket the last poll listed carries an empty title";
    case "no-trunk-branch":
      return "this project's registration states no trunk branch";
  }
}

/**
 * The refusal an unbriefable item-scoped birth earns, or `null` to go ahead. PURE.
 *
 * `null` for a birth carrying NO work item: a registration that states a prompt
 * and no item births prompt-only on purpose, and that shape stays legal. The
 * refusal is only for a birth aimed at a queue item the daemon cannot describe.
 */
export function unbriefableBirthRefusal(
  registration: { readonly trunk?: { readonly branch: string } } | undefined,
  birth: { readonly project_label: string; readonly work_item?: string },
  projects: readonly DemandBriefPoll[],
): string | null {
  if (birth.work_item == null) return null;
  const verdict = demandBriefVerdict(
    registration,
    queueBriefing(projects, birth.project_label, birth.work_item),
    projects.find((project) => project.project_label === birth.project_label),
  );
  if (verdict.briefed || verdict.gap == null) return null;
  return (
    `the daemon cannot brief a Worker for item ${birth.work_item}: ${describeDemandBriefGap(verdict.gap)}, ` +
    `so a birth would echo its prompt and die with the item still queued`
  );
}

/**
 * Refuse an unbriefable birth, or return so the caller may perform it.
 *
 * The decision is `unbriefableBirthRefusal`'s and stays pure; this is the throw
 * the demand loop's existing refusal path already catches — it arms the host
 * backoff and states the missing fact where a stall is read. It lives here, and
 * not as a branch at the call site, because the daemon's start function is a
 * baselined complexity the ratchet will not let grow.
 */
export function refuseUnbriefableBirth(
  registration: { readonly trunk?: { readonly branch: string } } | undefined,
  birth: { readonly project_label: string; readonly work_item?: string },
  projects: readonly DemandBriefPoll[],
): void {
  const refused = unbriefableBirthRefusal(registration, birth, projects);
  if (refused != null) throw new Error(refused);
}
