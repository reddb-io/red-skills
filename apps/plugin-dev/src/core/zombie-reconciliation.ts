// zombie-reconciliation — a Worker that returns after the world moved is
// reconciled, never believed (ADR 0155, Spec #4164, #4176).
//
// **The world does not pause while a Worker works.** Between the moment a
// Worker takes a claim and the moment it announces a branch, its claim can be
// conceded by a staleness sweep, released eagerly by the death sweep (#4136),
// or taken by another Worker; the Ticket it holds can be closed by somebody
// else's PR; and `origin/<base>` can advance past the generation it forked
// from. Any one of those makes the Worker a ZOMBIE — alive, finished, and
// holding an account of a world that no longer exists.
//
// Nothing in the landing path noticed. `doLanding` asked whether the branch was
// pushable and whether its head still matched the SHA the gate validated
// (#4134); it never asked whether the WORK was still wanted. So a zombie's push
// landed on a Ticket that had already moved on, and the queue learned about it
// from the merge.
//
// ## Two answers, and never a third
//
// **Nothing a zombie produced is landed.** The refusal is the whole point: the
// gate that validated the work judged a base that is gone, and the claim that
// authorised it belongs to somebody else. What the work is worth is a decision
// the queue makes with the branch in front of it, which is why salvage always
// travels through the tracker:
//
//   - **a reconciliation Ticket** when the original is no longer ours to write
//     — it is closed, or another Worker holds its claim. A fresh Ticket carries
//     the branch, the head SHA and the displacement, and enters triage like any
//     other demand.
//   - **an evidenced park** when the original is still open and unheld. The
//     Ticket is where this work belongs; it goes back to a human with the
//     evidence attached rather than to a Worker that would repeat the race.
//
// Both land nothing. The choice is about WHERE the salvage is addressed, never
// about whether the merge may proceed.
//
// PURE planner, thin executor: every read and every mutation is injected, so a
// simulated zombie flows through one plan in a unit test.

import type { Exec } from "./merge.js";
import { resolveRemoteBranchTip } from "./stale-head.js";
import { transitionLabels, type StateTransition } from "./state-transition.js";
import { LABEL_READY, LABEL_RUNNING } from "./triage-labels.js";

/** Every way the world can move under a Worker that is still working. */
export const ZOMBIE_DISPLACEMENTS = [
  "claim-released",
  "claim-taken",
  "base-moved",
  "issue-closed",
] as const;

export type ZombieDisplacement = (typeof ZOMBIE_DISPLACEMENTS)[number];

/** One line per displacement, addressed to whoever the landing just refused. */
export const ZOMBIE_DISPLACEMENT_REASONS: Readonly<Record<ZombieDisplacement, string>> = {
  "claim-released": "the claim this Worker held was released while it was working",
  "claim-taken": "another Worker holds the claim on this Ticket now",
  "base-moved": "the base generation advanced past the commit this work forked from",
  "issue-closed": "the Ticket this work targets was closed while the Worker was working",
};

/**
 * What the Worker knew at the fork, and what the tracker says now.
 *
 * Declared structurally rather than read from a tracker client so the planner
 * stays a value function: a test poses a zombie by writing one down, and the
 * transport is the caller's.
 */
export interface ZombieWatch {
  /** The daemon's key for the Worker that is returning. */
  readonly workerId: string;
  /** Its claim marker identity, `<host>:<worker_id>`. */
  readonly claimOwner: string;
  /** Claim owners the Ticket still reads as HOLDING, read now. */
  readonly activeClaimOwners: readonly string[];
  /** Claim owners that withdrew, read now. */
  readonly concededClaimOwners?: readonly string[];
  /** `origin/<base>` at the moment this Worker forked; absent → not compared. */
  readonly baseAtStart?: string | null;
  /** The Ticket's open state, read now; absent → assumed open. */
  readonly issueOpen?: boolean;
}

/** Everything the planner needs: the watch, the live base, and the salvage. */
export interface ZombieFacts extends ZombieWatch {
  /** The Ticket the Worker claimed. */
  readonly issue: number;
  /** The branch the Worker pushed, which is the salvage. */
  readonly branch: string;
  /** The tip the Worker's gate validated, when the caller pinned one. */
  readonly headSha?: string | null;
  /** `origin/<base>` now; absent → the base could not be read, so not compared. */
  readonly baseNow?: string | null;
  /** The base branch name, for the salvage note. */
  readonly base?: string;
  /** The Ticket's title, echoed into a reconciliation Ticket. */
  readonly title?: string;
  /** The Ticket's labels as the caller read them; absent → the claim lane's pair. */
  readonly currentLabels?: readonly string[];
}

/**
 * Every way this Worker's world moved, in declaration order. PURE.
 *
 * An empty result is the ordinary case and the reason this is cheap enough to
 * sit on the landing path: a Worker whose claim is still its own, on a base
 * that has not moved, is not a zombie and pays one string comparison to prove
 * it.
 */
export function detectZombieDisplacements(watch: ZombieWatch & {
  readonly baseNow?: string | null;
}): ZombieDisplacement[] {
  const found: ZombieDisplacement[] = [];
  const active = watch.activeClaimOwners;
  const conceded = watch.concededClaimOwners ?? [];
  if (conceded.includes(watch.claimOwner) || !active.includes(watch.claimOwner)) {
    found.push("claim-released");
  }
  if (active.some((owner) => owner !== watch.claimOwner)) found.push("claim-taken");
  if (
    watch.baseAtStart != null && watch.baseNow != null &&
    watch.baseAtStart !== watch.baseNow
  ) {
    found.push("base-moved");
  }
  if (watch.issueOpen === false) found.push("issue-closed");
  return found;
}

export type ZombieVerdict =
  | { readonly zombie: false }
  | {
      readonly zombie: true;
      readonly displacements: readonly ZombieDisplacement[];
      readonly message: string;
    };

/**
 * Is this completion a zombie's? PURE.
 *
 * The message names every displacement rather than the first, because a Worker
 * whose claim was released AND whose base moved is a different repair from one
 * that only lost a race, and the reader of the refusal is the one who has to
 * tell them apart.
 */
export function zombieVerdict(watch: ZombieWatch & {
  readonly baseNow?: string | null;
}): ZombieVerdict {
  const displacements = detectZombieDisplacements(watch);
  if (displacements.length === 0) return { zombie: false };
  const reasons = displacements.map((kind) => ZOMBIE_DISPLACEMENT_REASONS[kind]).join("; ");
  return {
    zombie: true,
    displacements,
    message:
      `the world moved while \`${watch.claimOwner}\` was working — ${reasons}. ` +
      "Nothing is landed: the salvage is reconciled against the current queue " +
      "and ledger state before any of it is accepted (#4176)",
  };
}

/**
 * The landing precondition, resolving the live base itself. Returns the refusal
 * text, or `null` when the landing may proceed.
 *
 * A caller that states no watch is not judged: the check is opt-in because only
 * a caller that knows the world at the fork can say whether it moved, and a
 * default answer of "zombie" for every caller that cannot would refuse every
 * landing in the repo.
 */
export async function zombieLandingRefusal(
  exec: Exec,
  input: {
    readonly repoDir: string;
    readonly remote: string;
    readonly base: string;
    readonly zombieWatch?: ZombieWatch;
  },
): Promise<string | null> {
  const watch = input.zombieWatch;
  if (watch === undefined) return null;
  const baseNow = watch.baseAtStart == null
    ? null
    : await resolveRemoteBranchTip(exec, {
        repo: input.repoDir, remote: input.remote, branch: input.base,
      }) ?? null;
  const verdict = zombieVerdict({ ...watch, baseNow });
  return verdict.zombie ? verdict.message : null;
}

/** Where the salvage is addressed. Never "the merge proceeds". */
export type ZombieSalvage = "reconciliation-ticket" | "evidenced-park";

/** A fresh Ticket carrying the salvage, ready for the tracker to mint. */
export interface ZombieReconciliationTicket {
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
}

/** The park a still-open, unheld Ticket earns instead of a new one. */
export interface ZombiePark {
  readonly issue: number;
  readonly comment: string;
  /**
   * The transition the planner applies — a plain human gate.
   *
   * The delta is never written here: ADR 0122 rule 5 has one place where a
   * state role changes, and a module that composed its own label pair would be
   * the second.
   */
  readonly transition: StateTransition;
  /** The label set the plan is computed against. */
  readonly currentLabels: readonly string[];
}

export interface ZombieReconciliationPlan {
  /** Always `refused`. Stated as a field so a reader never has to infer it. */
  readonly landing: "refused";
  readonly issue: number;
  readonly workerId: string;
  readonly displacements: readonly ZombieDisplacement[];
  readonly salvage: ZombieSalvage;
  readonly evidence: string;
  /** Present when `salvage` is `reconciliation-ticket`. */
  readonly ticket?: ZombieReconciliationTicket;
  /** Present when `salvage` is `evidenced-park`. */
  readonly park?: ZombiePark;
  /** The claim to withdraw first, when this Worker still holds one. */
  readonly concede: string | null;
}

/**
 * The evidence every salvage route quotes. PURE.
 *
 * The branch and the head SHA lead, because the first question a reader of
 * either route asks is "where is the work?" and an answer they have to
 * reconstruct from a Worker id is an answer they will not go and get.
 */
export function renderZombieEvidence(facts: ZombieFacts): string {
  const parts = [`branch=\`${facts.branch}\``];
  if (facts.headSha != null && facts.headSha !== "") parts.push(`head=${facts.headSha.slice(0, 12)}`);
  parts.push(`worker=\`${facts.claimOwner}\``);
  if (facts.baseAtStart != null) {
    const base = facts.base == null ? "base" : `origin/${facts.base}`;
    const now = facts.baseNow == null ? "unreadable" : facts.baseNow.slice(0, 12);
    parts.push(`${base} ${facts.baseAtStart.slice(0, 12)} → ${now}`);
  }
  const holders = facts.activeClaimOwners.filter((owner) => owner !== facts.claimOwner);
  if (holders.length > 0) parts.push(`claim now held by ${holders.map((o) => `\`${o}\``).join(", ")}`);
  if (facts.issueOpen === false) parts.push("the Ticket is closed");
  return parts.join("; ");
}

/**
 * Which door the salvage goes through. PURE.
 *
 * The rule is ownership, not severity: a Ticket that is closed or claimed by
 * another Worker is not ours to write on, and parking it would reopen somebody
 * else's finished work or steal a live Worker's Ticket out from under it.
 */
export function zombieSalvageRoute(
  displacements: readonly ZombieDisplacement[],
): ZombieSalvage {
  return displacements.includes("issue-closed") || displacements.includes("claim-taken")
    ? "reconciliation-ticket"
    : "evidenced-park";
}

/**
 * Plan one zombie's reconciliation. PURE — no clock, no IO, no tracker.
 *
 * Callers reach this only after {@link zombieVerdict} said `zombie: true`; a
 * completion whose world did not move has nothing to reconcile, and the planner
 * says so by refusing to invent a displacement it did not observe.
 */
export function planZombieReconciliation(facts: ZombieFacts): ZombieReconciliationPlan | null {
  const displacements = detectZombieDisplacements(facts);
  if (displacements.length === 0) return null;
  const evidence = renderZombieEvidence(facts);
  const salvage = zombieSalvageRoute(displacements);
  const reasons = displacements.map((kind) => `- ${ZOMBIE_DISPLACEMENT_REASONS[kind]}`).join("\n");
  const concede = facts.activeClaimOwners.includes(facts.claimOwner) ? facts.claimOwner : null;
  const base = {
    landing: "refused" as const,
    issue: facts.issue,
    workerId: facts.workerId,
    displacements,
    salvage,
    evidence,
    concede,
  };
  return salvage === "reconciliation-ticket"
    ? { ...base, ticket: buildReconciliationTicket(facts, reasons, evidence) }
    : { ...base, park: buildZombiePark(facts, reasons, evidence) };
}

function buildReconciliationTicket(
  facts: ZombieFacts,
  reasons: string,
  evidence: string,
): ZombieReconciliationTicket {
  const title = facts.title == null || facts.title === ""
    ? `Reconcile salvaged work from #${facts.issue}`
    : `Reconcile salvaged work from #${facts.issue}: ${facts.title}`;
  return {
    title,
    labels: [],
    body:
      `A Worker finished work for #${facts.issue} after the world moved, so nothing was landed.\n\n` +
      `**Why the landing was refused**\n${reasons}\n\n` +
      `**Where the salvage is**\n${evidence}\n\n` +
      "The branch is unmerged and unvalidated against the current base. Decide what of it is " +
      "still wanted, rebase what is, and discard the rest — this Ticket exists so that decision " +
      "is made with the branch in front of you rather than by a merge nobody reviewed (#4176).",
  };
}

function buildZombiePark(facts: ZombieFacts, reasons: string, evidence: string): ZombiePark {
  return {
    issue: facts.issue,
    transition: { kind: "human" },
    currentLabels: facts.currentLabels ?? [LABEL_RUNNING, LABEL_READY],
    comment:
      "🤖 Zombie reconciliation: a Worker finished this Ticket after the world moved, " +
      "so nothing was landed.\n\n" +
      `**Why the landing was refused**\n${reasons}\n\n` +
      `**Where the salvage is**\n${evidence}\n\n` +
      "Requeue it once you have decided whether the branch is still the answer; a blind " +
      "requeue would repeat the race that produced this park (#4176).",
  };
}

/** The mutations one reconciliation performs. Narrow on purpose. */
export interface ZombieReconciliationIO {
  /** Withdraw the returning Worker's claim, when it still holds one. */
  concede(issue: number, owner: string): Promise<void>;
  /** Mint the reconciliation Ticket; answers its number. */
  openTicket(ticket: ZombieReconciliationTicket): Promise<number>;
  comment(issue: number, body: string): Promise<void>;
  editLabels(issue: number, remove: readonly string[], add: readonly string[]): Promise<void>;
}

export interface ZombieReconciliationResult {
  /** Always false. The type states the invariant the executor cannot break. */
  readonly landed: false;
  readonly salvage: ZombieSalvage;
  /** The reconciliation Ticket that was minted, when that was the route. */
  readonly reconciliationIssue?: number;
  /** The Ticket that was parked, when that was the route. */
  readonly parkedIssue?: number;
  /** Set when a step failed; the plan is unchanged and may be replayed. */
  readonly failure?: string;
}

/**
 * Apply one plan. THIN — every decision was already made.
 *
 * Concede first, then write: the withdrawal must land before the label
 * projection changes so no reader ever sees an unclaimed-but-still-`running`
 * Ticket, exactly as the death sweep orders its own tick. A failure is reported
 * rather than thrown, because a reconciliation that could not write is still a
 * landing that correctly did not happen.
 */
export async function executeZombieReconciliation(
  plan: ZombieReconciliationPlan,
  io: ZombieReconciliationIO,
): Promise<ZombieReconciliationResult> {
  try {
    if (plan.concede != null) await io.concede(plan.issue, plan.concede);
    if (plan.ticket !== undefined) {
      const reconciliationIssue = await io.openTicket(plan.ticket);
      await io.comment(
        plan.issue,
        `🤖 Zombie reconciliation: nothing was landed for this Ticket; the salvage is tracked in #${reconciliationIssue} (${plan.evidence}).`,
      );
      return { landed: false, salvage: plan.salvage, reconciliationIssue };
    }
    const park = plan.park!;
    const applied = await transitionLabels(
      (remove, add) => io.editLabels(park.issue, remove, add),
      park.currentLabels,
      park.transition,
    );
    if (!applied.applied) return { landed: false, salvage: plan.salvage, failure: applied.reason };
    await io.comment(park.issue, park.comment);
    return { landed: false, salvage: plan.salvage, parkedIssue: park.issue };
  } catch (error) {
    return {
      landed: false,
      salvage: plan.salvage,
      failure: error instanceof Error ? error.message : String(error),
    };
  }
}
