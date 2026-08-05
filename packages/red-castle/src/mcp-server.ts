#!/usr/bin/env node
import { createClaimTools, type ClaimDependencies } from "./mcp/claim.js";
import { createHelpTools, type HelpDependencies } from "./mcp/help.js";
import { createMergeTools, type MergeDependencies } from "./mcp/merge.js";
import { createHitlTools, type HitlDependencies } from "./mcp/hitl.js";
import type { HostDependencies } from "./mcp/host.js";
import { applyOutputContracts } from "./mcp/contracts.js";
import { createProjectTools, type ProjectDependencies } from "./mcp/project.js";
import { createGateTools, type GateDependencies } from "./mcp/gate.js";
import { createDeadendTools, type DeadendDependencies } from "./mcp/deadend.js";
import { createHygieneTools, type HygieneDependencies } from "./mcp/hygiene.js";
import { createLandingTools, type LandingDependencies } from "./mcp/landing.js";
import {
  createObservabilityTools,
  type EventsSinceInput,
  type ObservabilityDependencies,
} from "./mcp/observability.js";
import {
  createReviewTools,
  type ReviewDependencies,
} from "./mcp/review.js";
import { createRunnerTools, type RunnerDependencies } from "./mcp/runner.js";
import {
  createStatuslineTools,
  type StatuslineDependencies,
} from "./mcp/statusline.js";
import { createStatusTools } from "./mcp/status.js";
import type { CastleMcpTool } from "./mcp/tool.js";
import { applyDangerPosture, type DangerPosture } from "./mcp/posture.js";
import { createWaitTools, type WaitDependencies } from "./mcp/wait.js";
import { createWorkerTools, type WorkerDependencies } from "./mcp/worker.js";
import {
  createWorktreeTools,
  type WorktreeDependencies,
} from "./mcp/worktree.js";

export type { CastleMcpTool } from "./mcp/tool.js";
export { CASTLE_MCP_PROMPTS } from "./mcp/prompt.js";
export type { CastleMcpPrompt } from "./mcp/prompt.js";
export type { DangerPosture } from "./mcp/posture.js";
export type { StatusInput, StatusScope } from "./mcp/status.js";
export {
  CASTLE_MCP_CONTRACT_VERSION,
  projectStatusOutputSchema,
  monitorOutputSchema,
  queueStatusOutputSchema,
  workerVitalsOutputSchema,
  workerVitalsProjectedOutputSchema,
} from "./mcp/contracts.js";
export type {
  CastleMcpOutputContract,
  ProjectStatusOutput,
  MonitorOutput,
  QueueStatusOutput,
  WorkerVitalsOutput,
  WorkerVitalsProjectedOutput,
} from "./mcp/contracts.js";
export type {
  WorkSelectorInput,
  ProjectDrainInput,
  ProjectStartInput,
  ProjectResizeInput,
  ProjectResetInput,
  ProjectStopInput,
} from "./mcp/project.js";
export type { EventsSinceInput, LogsInput, QueueStatusInput, WorkerVitalsInput } from "./mcp/observability.js";
export type { DeadendDependencies } from "./mcp/deadend.js";
export type {
  WorkerDispatchInput,
  WorkerStatusInput,
  WorkerStopInput,
} from "./mcp/worker.js";
export type {
  RunnerDetectInput,
  WorkerSteerInput,
  WorkerSteerStatusInput,
  WorkerRequestInput,
} from "./mcp/runner.js";
export type { RequeueToolInput, RetakeToolInput } from "./mcp/hygiene.js";
export type { GateRunInput } from "./mcp/gate.js";
export type { LandBranchInput, CascadeStatusInput } from "./mcp/landing.js";
export type { ClaimIssueInput } from "./mcp/claim.js";
export type { MergeArmInput } from "./mcp/merge.js";
export type { HitlResolveInput, HitlDecision } from "./mcp/hitl.js";
export type { WorktreeRemoveInput } from "./mcp/worktree.js";
export type { WaitStartInput, WaitStatusInput } from "./mcp/wait.js";
export type {
  DailyReviewInput,
  WeeklyReviewInput,
  TriageToolInput,
  RespondToolInput,
} from "./mcp/review.js";

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
 * Compose the published castle tool surface from the per-domain registries.
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
