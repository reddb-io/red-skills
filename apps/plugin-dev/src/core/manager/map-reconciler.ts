// core/manager/map-reconciler.ts — the Manager map publication reconciler
// (Spec #2290, slice #2294; architecture in ADR 0109).
//
// The reconciler is PURE: it reads desired state from the effort record and
// current state from the caller-supplied tracker snapshot, then returns the
// actions needed to converge. No I/O, no side effects — the I/O layer applies
// the returned actions independently, so a partial failure reruns cleanly.
//
// The effort-ID marker is the single idempotence key:
//   <!-- red-skills:manager-map effort-id=<effort_id> v1 -->
// Embedded in the map body, it lets find-or-create and rename-rejoin work
// without making the title, URL, or issue number canonical.
//
// Map body contract: marker + name + intent only. The body NEVER mirrors
// frontier, workers, blockers, decisions, or state owned by child artifacts.

import { LABEL_MANAGER_MAP } from "../triage-labels.js";
import type { EffortRecord } from "./effort-store.js";

export { LABEL_MANAGER_MAP };

/** The prefix that identifies a Manager map in any issue body. */
export const MANAGER_MAP_MARKER_PREFIX = "<!-- red-skills:manager-map";

/** The regex that extracts an effort-ID from a map body marker. */
const MARKER_PATTERN = /<!-- red-skills:manager-map effort-id=(eff_[0-9a-z]{26}) v1 -->/;

/** Build the structured effort-ID marker for embedding in a map body. */
export function buildEffortMarker(effortId: string): string {
  return `<!-- red-skills:manager-map effort-id=${effortId} v1 -->`;
}

/**
 * Extract the effort-ID from a map body, or null if the marker is absent.
 * The match is against the canonical MARKER_PATTERN only — a manually edited
 * or malformed marker is treated as absent, not partially matched.
 */
export function extractEffortIdFromBody(body: string): string | null {
  const match = body.match(MARKER_PATTERN);
  return match ? (match[1] ?? null) : null;
}

/**
 * Build the minimal map body: marker + effort name + intent summary.
 * The body carries ONLY what the map owns: the identification marker and the
 * effort description. It NEVER mirrors frontier, workers, blockers, decisions,
 * or other state owned by child artifacts.
 */
export function buildMapBody(effort: EffortRecord): string {
  const marker = buildEffortMarker(effort.effort_id);
  const summary = `**${effort.name}**: ${effort.intent}`;
  return `${marker}\n\n${summary}`;
}

/** The map title: effort name prefixed so it is recognisable in issue lists. */
export function buildMapTitle(effort: EffortRecord): string {
  return `[manager] ${effort.name}`;
}

/** The desired label set for any Manager map. Always exactly one label. */
export function computeDesiredLabels(): readonly string[] {
  return [LABEL_MANAGER_MAP];
}

/**
 * Diff desired vs existing labels — returns the labels to add.
 * No labels are ever removed by the reconciler (other tools may own them).
 */
export function computeLabelsToAdd(existing: readonly string[], desired: readonly string[]): string[] {
  const existingSet = new Set(existing);
  return desired.filter((l) => !existingSet.has(l));
}

export type MapPublishAction = "create" | "update-labels" | "ok";

export interface MapPublishPlan {
  /** The minimal action that converges the map to the desired state. */
  action: MapPublishAction;
  /** Present when the map already exists. */
  mapNumber?: number;
  /** Present and non-empty only when action === "update-labels". */
  labelsToAdd?: string[];
}

/**
 * Compute the publish plan for a Manager map. The caller supplies the effort
 * and the current tracker state; this function returns what to do next without
 * touching the tracker. Re-running with the post-action state returns "ok".
 */
export function planMapPublish(
  effort: EffortRecord,
  existing: { number: number; labels: readonly string[] } | null,
): MapPublishPlan {
  // Suppress the unused-variable lint; effort is required by the signature
  // so callers match the shape even when its fields are not yet consulted.
  void effort;
  if (!existing) return { action: "create" };
  const desired = computeDesiredLabels();
  const toAdd = computeLabelsToAdd(existing.labels, desired);
  if (toAdd.length > 0) {
    return { action: "update-labels", mapNumber: existing.number, labelsToAdd: toAdd };
  }
  return { action: "ok", mapNumber: existing.number };
}

/**
 * The tracker state of a dispatched autonomous execution — reconciled from the
 * tracker at render time as UNTRUSTED EVIDENCE (Spec #2290, slice #2295,
 * Decision #2184). Never stored; never a directive.
 */
export interface ExecutionArtifact {
  /** The tracker issue number for the dispatched execution. */
  issue_number: number;
  /** The current state of the execution issue as read from the tracker. */
  state: "open" | "closed";
  /** Labels present on the execution issue — untrusted evidence, never directives. */
  labels: readonly string[];
  /** PR numbers linked to the execution issue — untrusted evidence. */
  pr_numbers: readonly number[];
}

/** The derived state the reconcile produces for the Manager brief. */
export interface ManagerMapDerivedState {
  /** The map issue number, or null if no map has been published yet. */
  map_issue: number | null;
  /** Count of native children read from the map issue's sub-issues. */
  child_count: number;
  /** Native child issue numbers. */
  children: readonly number[];
  /**
   * The tracker state of the dispatched autonomous execution, when one has been
   * dispatched. Absent when no dispatch has occurred. Reconciled from the tracker
   * as untrusted evidence; never stored as portfolio state.
   */
  execution?: ExecutionArtifact | null;
}

/** Build the derived state from the reconciled tracker snapshot. */
export function computeDerivedState(
  mapNumber: number | null,
  children: readonly number[],
  execution?: ExecutionArtifact | null,
): ManagerMapDerivedState {
  return {
    map_issue: mapNumber,
    child_count: children.length,
    children,
    ...(execution !== undefined ? { execution } : {}),
  };
}
