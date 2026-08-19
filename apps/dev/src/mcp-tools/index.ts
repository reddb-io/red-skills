#!/usr/bin/env node
import { createClaimTools, type ClaimDependencies } from "./claim.js";
import { createHelpTools, type HelpDependencies } from "./help.js";
import { createMergeTools, type MergeDependencies } from "./merge.js";
import { createHitlTools, type HitlDependencies } from "./hitl.js";
import type { HostDependencies } from "./host.js";
import { applyOutputContracts } from "./contracts.js";
import { createProjectTools, type ProjectDependencies } from "./project.js";
import { createGateTools, type GateDependencies } from "./gate.js";
import { createDeadendTools, type DeadendDependencies } from "./deadend.js";
import { createHygieneTools, type HygieneDependencies } from "./hygiene.js";
import { createLandingTools, type LandingDependencies } from "./landing.js";
import {
  createObservabilityTools,
  type ObservabilityDependencies,
} from "./observability.js";
import {
  createReviewTools,
  type ReviewDependencies,
} from "./review.js";
import { createRunnerTools, type RunnerDependencies } from "./runner.js";
import {
  createStatuslineTools,
  type StatuslineDependencies,
} from "./statusline.js";
import { createStatusTools } from "./status.js";
import type { CastleMcpTool } from "./tool.js";
import { applyDangerPosture, type DangerPosture } from "./posture.js";
import { createWaitTools, type WaitDependencies } from "./wait.js";
import { createWorkerTools, type WorkerDependencies } from "./worker.js";
import {
  createWorktreeTools,
  type WorktreeDependencies,
} from "./worktree.js";

/**
 * The published name of the dev plugin's Plugin MCP (ADR 0147 rule 2).
 *
 * A plugin ships ONE MCP named `rs_<plugin>` — a thin, stateless ACP client of
 * the `redskilled` daemon. The `rs_` prefix is visible on purpose: it survives
 * hosts that do not namespace a server by its plugin, where the bare name of
 * the daemon would read as the daemon itself rather than as a client of it.
 */
export const RS_DEV_MCP_SERVER_NAME = "rs_dev";

export type { CastleMcpTool } from "./tool.js";
export { CASTLE_MCP_PROMPTS } from "./prompt.js";
export type { CastleMcpPrompt } from "./prompt.js";
export type { DangerPosture } from "./posture.js";
export type { StatusInput, StatusScope } from "./status.js";
export {
  CASTLE_MCP_CONTRACT_VERSION,
  projectStatusOutputSchema,
  monitorOutputSchema,
  queueStatusOutputSchema,
  workerVitalsOutputSchema,
  workerVitalsProjectedOutputSchema,
} from "./contracts.js";
export type {
  CastleMcpOutputContract,
  ProjectStatusOutput,
  MonitorOutput,
  QueueStatusOutput,
  WorkerVitalsOutput,
  WorkerVitalsProjectedOutput,
} from "./contracts.js";
export type {
  WorkSelectorInput,
  ProjectDrainInput,
  ProjectStartInput,
  ProjectResizeInput,
  ProjectResetInput,
  ProjectStopInput,
} from "./project.js";
export type { EventsSinceInput, LogsInput, QueueStatusInput, WorkerVitalsInput } from "./observability.js";
export type { DeadendDependencies } from "./deadend.js";
export type {
  WorkerDispatchInput,
  WorkerStatusInput,
  WorkerStopInput,
} from "./worker.js";
export type {
  RunnerDetectInput,
  WorkerSteerInput,
  WorkerSteerStatusInput,
  WorkerRequestInput,
} from "./runner.js";
export type { RequeueToolInput, RetakeToolInput } from "./hygiene.js";
export type { GateRunInput } from "./gate.js";
export type { LandBranchInput, CascadeStatusInput } from "./landing.js";
export type { ClaimIssueInput } from "./claim.js";
export type { MergeArmInput } from "./merge.js";
export type { HitlResolveInput, HitlDecision } from "./hitl.js";
export type { WorktreeRemoveInput } from "./worktree.js";
export type { WaitStartInput, WaitStatusInput } from "./wait.js";
export type {
  DailyReviewInput,
  WeeklyReviewInput,
  TriageToolInput,
  RespondToolInput,
} from "./review.js";

/**
 * The host adapter implements every capability domain at once, so the
 * dependency contract is the union of the per-domain contracts. A new tool
 * extends its own domain's interface — this composition never changes.
 */
export interface CastleMcpDependencies
  extends
    HelpDependencies,
    ProjectDependencies,
    HostDependencies,
    ObservabilityDependencies,
    DeadendDependencies,
    WorkerDependencies,
    RunnerDependencies,
    HygieneDependencies,
    GateDependencies,
    LandingDependencies,
    ClaimDependencies,
    MergeDependencies,
    HitlDependencies,
    WorktreeDependencies,
    WaitDependencies,
    ReviewDependencies,
    StatuslineDependencies {}

/**
 * Compose the published redskilled tool surface from the per-domain registries.
 * The concatenation order IS the published order — `mcp-tool-surface.test.ts`
 * freezes it.
 *
 * `posture` controls how tools that declare a `dangerClass` are gated:
 *   - `"allow"` (default) — unchanged behavior.
 *   - `"confirm"` — dangerous tools require `confirmation: true` in the input.
 *   - `"deny"` — dangerous tools always return a structured refusal.
 *
 * Output contracts wrap BEFORE the posture gate, so a posture refusal — which
 * is deliberately not the tool's declared payload — never trips validation.
 */
export function createCastleMcpTools(
  deps: CastleMcpDependencies,
  posture: DangerPosture = "allow",
): CastleMcpTool[] {
  let publishedTools: CastleMcpTool[] = [];
  const tools = [
    ...createHelpTools(deps, () => publishedTools),
    ...createStatusTools(deps),
    ...createProjectTools(deps),
    ...createObservabilityTools(deps),
    ...createDeadendTools(deps),
    ...createWorkerTools(deps),
    ...createRunnerTools(deps),
    ...createHygieneTools(deps),
    ...createGateTools(deps),
    ...createLandingTools(deps),
    ...createClaimTools(deps),
    ...createMergeTools(deps),
    ...createHitlTools(deps),
    ...createWorktreeTools(deps),
    ...createWaitTools(deps),
    ...createReviewTools(deps),
    ...createStatuslineTools(deps),
  ];
  publishedTools = applyDangerPosture(applyOutputContracts(tools), posture);
  return publishedTools;
}
