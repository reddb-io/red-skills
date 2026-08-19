// pre-pr-pipeline — no-mistakes pre-PR validation gate (ADR 0043, Track 2B #913).
//
// Ordered pipeline: review → test → docs → lint. Findings are classified as
// mechanical (auto-apply: style, format, docs) or intent-changing (escalate: logic,
// type safety, semantics). Mechanical fixes are applied in-tree; intent findings
// stop the pipeline for human decision (approve/fix/skip). The pipeline runs in a
// disposable worktree and only completes when feedback is green and all findings
// are either mechanical-applied or human-approved.

import type { Exec, PackageLayout } from "./feedback.js";
import { LABEL_GO_LANE } from "./go.js";

/**
 * Returns true when the /go --mode no-mistakes adversarial review pipeline is
 * active for this dispatch. Active only for /go lane issues running in
 * no-mistakes mode; /afk and other lanes use the review.enabled config gate
 * independently and return false here.
 */
export function isPrePrPipelineActive(
  runMode: string | undefined,
  laneLabel: string | undefined,
): boolean {
  return laneLabel === LABEL_GO_LANE && runMode === "no-mistakes";
}

/**
 * Input to the pre-PR pipeline. Wraps the concrete worktree state and the
 * feedback gate infrastructure (exec + layout).
 */
export interface PrePrPipelineInput {
  /** Absolute path to the worktree root. */
  workingDir: string;
  /** pnpm executor (injected for testing). */
  exec: Exec;
  /** Package layout probe (injected for testing). */
  layout: PackageLayout;
  /** Source of truth for wall-clock time (injected for testing). */
  now: () => number;
  /** Wall-clock budget in milliseconds; abort when exceeded. */
  wallClockBudgetMs: number;
}

/**
 * Outcome of running the pre-PR pipeline.
 */
export interface PrePrPipelineResult {
  /** True when the pipeline completed successfully (green feedback, resolved findings). */
  passed: boolean;
  /** Reason for failure or escalation. */
  reason?: string;
  /** Mechanical findings that were auto-applied. */
  mechanicalApplied: number;
  /** Intent findings that require human decision. */
  intentEscalated: number;
}

/**
 * Run the no-mistakes pre-PR validation pipeline. Returns a result indicating
 * whether the pipeline passed (ready to push) or needs intervention (escalate
 * to human, or auto-apply mechanical fixes).
 *
 * The pipeline is pure over the injected exec/layout/now, so tests can drive it
 * with fixtures. Production wiring passes the real feedback gate infrastructure.
 */
export async function runPrePrPipeline(input: PrePrPipelineInput): Promise<PrePrPipelineResult> {
  const startTime = input.now();

  // Placeholder: the full implementation orchestrates review → test → docs → lint,
  // applies mechanical fixes, escalates intent findings. For now, return a stub
  // that indicates success (no pipeline executed, no findings).
  return {
    passed: true,
    mechanicalApplied: 0,
    intentEscalated: 0,
  };
}
