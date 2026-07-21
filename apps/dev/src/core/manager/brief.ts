// core/manager/brief.ts — the Manager brief renderer (Spec #2290, slice #2291).
//
// The brief is a COMPUTED-ON-DEMAND render, never a stored snapshot: a stored
// brief either goes stale against the tracker or duplicates state its owner
// workflow already holds. This slice renders the owned lifecycle state alone;
// the derived state (HITL, blocked, frontier) joins the render in the
// reconciliation slice, freshly reconciled at render time — still never stored.
//
// `state_source: owned` says out loud which half of the brief the reader is
// looking at, so a brief from this slice can never be mistaken for a reconciled
// one once the derived half exists.

import { encodeDevSnapshotToon } from "../toon-snapshot.js";
import type { EffortRecord } from "./effort-store.js";

/** Render one effort's brief from its owned state. */
export function renderEffortBrief(effort: EffortRecord): string {
  return encodeDevSnapshotToon({
    kind: "manager.brief",
    state_source: "owned",
    effort_id: effort.effort_id,
    name: effort.name,
    lifecycle: effort.lifecycle,
    generation: effort.generation,
    intent: effort.intent,
    created_at: effort.created_at,
    updated_at: effort.updated_at,
  });
}

/** Render the brief for a portfolio with no effort yet — an answer, not silence. */
export function renderEmptyPortfolioBrief(): string {
  return encodeDevSnapshotToon({ kind: "manager.brief", state_source: "owned", efforts: 0 });
}
