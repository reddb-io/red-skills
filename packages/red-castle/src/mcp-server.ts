#!/usr/bin/env node
import { createClaimTools, type ClaimDependencies } from "./mcp/claim.js";
import { createFleetTools, type FleetDependencies } from "./mcp/fleet.js";
import { createGateTools, type GateDependencies } from "./mcp/gate.js";
import { createHygieneTools, type HygieneDependencies } from "./mcp/hygiene.js";
import { createLandingTools, type LandingDependencies } from "./mcp/landing.js";
import {
  createObservabilityTools,
  type ObservabilityDependencies,
} from "./mcp/observability.js";
import {
  createReviewTools,
  type ReviewDependencies,
} from "./mcp/review.js";
import { createRunnerTools, type RunnerDependencies } from "./mcp/runner.js";
import type { CastleMcpTool } from "./mcp/tool.js";
import { createWaitTools, type WaitDependencies } from "./mcp/wait.js";
import { createWorkerTools, type WorkerDependencies } from "./mcp/worker.js";
import {
  createWorktreeTools,
  type WorktreeDependencies,
} from "./mcp/worktree.js";

export type { CastleMcpTool } from "./mcp/tool.js";
export type {
  FleetSelectorInput,
  FleetCreateInput,
  FleetEditInput,
  FleetNameInput,
} from "./mcp/fleet.js";
export type { LogsInput } from "./mcp/observability.js";
export type {
  WorkerDispatchInput,
  WorkerStatusInput,
  WorkerStopInput,
} from "./mcp/worker.js";
export type {
  RunnerDetectInput,
  WorkerSteerInput,
  WorkerRequestInput,
} from "./mcp/runner.js";
export type { RequeueToolInput, RetakeToolInput } from "./mcp/hygiene.js";
export type { GateRunInput } from "./mcp/gate.js";
export type { LandBranchInput, CascadeStatusInput } from "./mcp/landing.js";
export type { ClaimIssueInput } from "./mcp/claim.js";
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
    FleetDependencies,
    ObservabilityDependencies,
    WorkerDependencies,
    RunnerDependencies,
    HygieneDependencies,
    GateDependencies,
    LandingDependencies,
    ClaimDependencies,
    WorktreeDependencies,
    WaitDependencies,
    ReviewDependencies {}

/**
 * Compose the published dev:afk tool surface from the per-domain registries.
 * The concatenation order IS the published order — `mcp-tool-surface.test.ts`
 * freezes it.
 */
export function createCastleMcpTools(
  deps: CastleMcpDependencies,
): CastleMcpTool[] {
  return [
    ...createFleetTools(deps),
    ...createObservabilityTools(deps),
    ...createWorkerTools(deps),
    ...createRunnerTools(deps),
    ...createHygieneTools(deps),
    ...createGateTools(deps),
    ...createLandingTools(deps),
    ...createClaimTools(deps),
    ...createWorktreeTools(deps),
    ...createWaitTools(deps),
    ...createReviewTools(deps),
  ];
}
