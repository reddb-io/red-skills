// core/relabel-sweep.ts — the pure planner for the Spec/Ticket vocabulary flip
// relabel sweep (ADR 0093, issue #1292).
//
// ADR 0093 adopts upstream v1.1.0's rename at total vocabulary scope: the label
// families `type:prd → type:spec` and `prd:N → spec:N`. The migration is a one
// time big-bang sweep over OPEN Tickets only — closed Tickets keep their
// historical labels (history is not rewritten). This module is the deterministic
// heart of that sweep: given each open Ticket's label set it returns the exact
// remove/add plan. The IO half (listing Tickets, creating missing target
// labels, applying edits) lives in `commands/relabel-sweep.ts`.
//
// The planner is PURE and idempotent by construction: it only ever plans the
// removal of an OLD-vocabulary label, and only adds a NEW-vocabulary label the
// Ticket does not already carry. Re-running over an already-migrated Ticket
// (no `type:prd`, no `prd:N`) yields no plan, so the real run no-ops on replay.

/** The source (old-vocabulary) type label the sweep migrates away from. */
export const OLD_TYPE_LABEL = "type:prd";
/** The target (new-vocabulary) type label the sweep migrates to. */
export const NEW_TYPE_LABEL = "type:spec";
/** Matches an old-vocabulary parent-ref label `prd:<N>` (capturing N). */
const OLD_REF_LABEL = /^prd:(\d+)$/;
/** Build the new-vocabulary parent-ref label for a given Spec number. */
export function newRefLabel(specNumber: string): string {
  return `spec:${specNumber}`;
}

/** An open Ticket's label state, the sweep's input row. */
export interface TicketLabelState {
  number: number;
  title?: string;
  labels: readonly string[];
}

/** The exact label edit planned for one Ticket. `remove`/`add` are never both
 * empty — a Ticket with nothing to migrate produces no plan at all. */
export interface TicketRelabelPlan {
  number: number;
  title?: string;
  remove: string[];
  add: string[];
}

/**
 * Plan the label migration for a single Ticket, or `null` when it carries no
 * old-vocabulary label (nothing to do — the idempotent no-op case).
 *
 * `type:prd` → remove it and add `type:spec` (unless already present). Each
 * `prd:N` → remove it and add `spec:N` (unless already present). Every other
 * label family — `req:*`, `ready-for-agent`, `type:bug`, … — is left untouched.
 */
export function planTicketRelabel(ticket: TicketLabelState): TicketRelabelPlan | null {
  const present = new Set(ticket.labels);
  const remove: string[] = [];
  const add: string[] = [];
  const queueAdd = (label: string): void => {
    // Never plan to add a label the Ticket already has, and never add the same
    // target twice (defends the theoretical `prd:5`+`prd:5` duplicate).
    if (!present.has(label) && !add.includes(label)) add.push(label);
  };

  for (const label of ticket.labels) {
    if (label === OLD_TYPE_LABEL) {
      remove.push(label);
      queueAdd(NEW_TYPE_LABEL);
      continue;
    }
    const ref = OLD_REF_LABEL.exec(label);
    if (ref) {
      remove.push(label);
      queueAdd(newRefLabel(ref[1]));
    }
  }

  if (remove.length === 0 && add.length === 0) return null;
  return { number: ticket.number, title: ticket.title, remove, add };
}

/**
 * Plan the sweep across every open Ticket, dropping the ones with nothing to
 * migrate. Order is preserved from the input.
 */
export function planRelabelSweep(tickets: readonly TicketLabelState[]): TicketRelabelPlan[] {
  const plans: TicketRelabelPlan[] = [];
  for (const ticket of tickets) {
    const plan = planTicketRelabel(ticket);
    if (plan) plans.push(plan);
  }
  return plans;
}

/**
 * The sorted, de-duplicated set of NEW-vocabulary labels the plans introduce —
 * the labels the real run must create on demand before applying any edit (a
 * `gh issue edit --add-label` for a non-existent label fails).
 */
export function targetLabelsToEnsure(plans: readonly TicketRelabelPlan[]): string[] {
  const set = new Set<string>();
  for (const plan of plans) for (const label of plan.add) set.add(label);
  return [...set].sort();
}
