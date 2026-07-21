// core/manager/brief.ts — the Manager brief renderer (Spec #2290, slices
// #2291 and #2294; architecture in ADR 0109).
//
// The brief is a COMPUTED-ON-DEMAND render, never a stored snapshot: a stored
// brief either goes stale against the tracker or duplicates state its owner
// workflow already holds. Two render paths:
//
//   renderEffortBrief          — owned lifecycle state only (slice #2291).
//   renderEffortBriefWithDerived — owned + freshly reconciled derived state
//                                 (slice #2294: map publication + children).
//
// `state_source` distinguishes the paths: "owned" vs "reconciled". A brief
// from the owned path can never be mistaken for a reconciled one.

import { encodeDevSnapshotToon } from "../toon-snapshot.js";
import type { ManagerMapDerivedState } from "./map-reconciler.js";
import type { EffortRecord } from "./effort-store.js";

/** Render one effort's brief from its owned state only. */
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

/**
 * Render one effort's brief with freshly reconciled derived state.
 * The derived state is NEVER stored — it is reconciled from the tracker at
 * render time so the brief can never go stale against the map's live children.
 */
export function renderEffortBriefWithDerived(
  effort: EffortRecord,
  derived: ManagerMapDerivedState,
): string {
  return encodeDevSnapshotToon({
    kind: "manager.brief",
    state_source: "reconciled",
    effort_id: effort.effort_id,
    name: effort.name,
    lifecycle: effort.lifecycle,
    generation: effort.generation,
    intent: effort.intent,
    created_at: effort.created_at,
    updated_at: effort.updated_at,
    map_issue: derived.map_issue,
    child_count: derived.child_count,
  });
}

/** Render the brief for a portfolio with no effort yet — an answer, not silence. */
export function renderEmptyPortfolioBrief(): string {
  return encodeDevSnapshotToon({ kind: "manager.brief", state_source: "owned", efforts: 0 });
}
