#!/usr/bin/env node
import { z } from "zod/v3";

export interface FleetSelectorInput {
  spec?: number;
  lane?: string;
  label?: string;
  issues?: number[];
}

export interface FleetCreateInput {
  name: string;
  runner: string;
  target: number;
  selector?: FleetSelectorInput;
  config?: Record<string, string | number | boolean>;
  base?: string;
}

export interface FleetEditInput {
  name: string;
  runner?: string;
  target?: number;
  selector?: FleetSelectorInput;
  config?: Record<string, string | number | boolean>;
  base?: string;
}

export interface FleetNameInput {
  name?: string;
}

export interface LogsInput {
  lane: "worker" | "supervisor" | "monitor" | "liveness";
  id: string;
}

export interface GateRunInput {
  worktree?: string;
  branch?: string;
  base?: string;
  changedFiles?: string[];
}

export interface LandBranchInput {
  issue: number;
  title: string;
  branch: string;
  base: string;
  gatePassed: true;
  openPr?: boolean;
  trunk?: string;
  validatedBranchTip?: string;
}

export interface ClaimIssueInput {
  issue: number;
}

export interface ClaimReleaseInput extends ClaimIssueInput {
  worker: string;
  runner?: string;
}

export interface WorktreeRemoveInput {
  worktree: string;
}

export interface CastleMcpDependencies {
  fleetList(): Promise<unknown>;
  fleetStatus(input: FleetNameInput): Promise<unknown>;
  fleetCreate(input: FleetCreateInput): Promise<unknown>;
  fleetEdit(input: FleetEditInput): Promise<unknown>;
  fleetStop(input: FleetNameInput): Promise<unknown>;
  logs(input: LogsInput): Promise<unknown>;
  workerVitals(): Promise<unknown>;
  dashboard(input: { periodDays: number }): Promise<unknown>;
  monitor(): Promise<unknown>;
  history(input: { limit?: number }): Promise<unknown>;
  queueStatus(): Promise<unknown>;
  gateRun(input: GateRunInput): Promise<unknown>;
  gateBaselineStatus(): Promise<unknown>;
  landBranch(input: LandBranchInput): Promise<unknown>;
  cascadeStatus(): Promise<unknown>;
  claimStatus(input: ClaimIssueInput): Promise<unknown>;
  claimRelease(input: ClaimReleaseInput): Promise<unknown>;
  worktreeList(): Promise<unknown>;
  worktreeRemove(input: WorktreeRemoveInput): Promise<unknown>;
}

export interface CastleMcpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodType>;
  invoke(input: Record<string, unknown>): Promise<unknown>;
}

const fleetSelectorShape = {
  spec: z.number().int().positive().optional(),
  lane: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  issues: z.array(z.number().int().positive()).optional(),
};

const fleetConfig = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]),
);

export function createCastleMcpTools(
  deps: CastleMcpDependencies,
): CastleMcpTool[] {
  return [
    {
      name: "fleet_list",
      title: "List AFK fleets",
      description: "List every registered named AFK fleet profile.",
      inputSchema: {},
      invoke: () => deps.fleetList(),
    },
    {
      name: "fleet_status",
      title: "Get AFK fleet status",
      description:
        "Return structured supervisor, slots, churn, and live-worker status for a named fleet.",
      inputSchema: { fleet: z.string().min(1).optional() },
      invoke: ({ fleet }) =>
        deps.fleetStatus({ name: fleet as string | undefined }),
    },
    {
      name: "fleet_create",
      title: "Create AFK fleet",
      description:
        "MUTATING: persist a named fleet profile and spawn its supervisor.",
      inputSchema: {
        name: z.string().min(1),
        runner: z.string().min(1),
        target: z.number().int().min(0).default(2),
        selector: z.object(fleetSelectorShape).optional(),
        config: fleetConfig.optional(),
        base: z.string().min(1).optional(),
      },
      invoke: (input) => deps.fleetCreate(input as unknown as FleetCreateInput),
    },
    {
      name: "fleet_edit",
      title: "Edit AFK fleet",
      description:
        "MUTATING: update a named fleet profile and send a live resize directive when requested.",
      inputSchema: {
        name: z.string().min(1),
        runner: z.string().min(1).optional(),
        target: z.number().int().min(0).optional(),
        selector: z.object(fleetSelectorShape).optional(),
        config: fleetConfig.optional(),
        base: z.string().min(1).optional(),
      },
      invoke: (input) => deps.fleetEdit(input as unknown as FleetEditInput),
    },
    {
      name: "fleet_stop",
      title: "Stop AFK fleet",
      description: "MUTATING: stop one named fleet and its detached workers.",
      inputSchema: { fleet: z.string().min(1).optional() },
      invoke: ({ fleet }) =>
        deps.fleetStop({ name: fleet as string | undefined }),
    },
    {
      name: "logs",
      title: "Read Castle logs",
      description:
        "Return raw CastleLaneRecord entries from one structured lane.",
      inputSchema: {
        lane: z.enum(["worker", "supervisor", "monitor", "liveness"]),
        id: z.string().min(1),
      },
      invoke: (input) => deps.logs(input as unknown as LogsInput),
    },
    {
      name: "worker_vitals",
      title: "Read worker vitals",
      description: "Return the liveness-qualified state of all local workers.",
      inputSchema: {},
      invoke: () => deps.workerVitals(),
    },
    {
      name: "dashboard",
      title: "Build AFK dashboard",
      description:
        "Build the structured operational dashboard from GitHub and local state.",
      inputSchema: {
        periodDays: z.number().int().positive().default(30),
      },
      invoke: ({ periodDays }) =>
        deps.dashboard({ periodDays: periodDays as number }),
    },
    {
      name: "monitor",
      title: "Read AFK monitor",
      description:
        "Return the current workers, history events, and fleet monitor inputs.",
      inputSchema: {},
      invoke: () => deps.monitor(),
    },
    {
      name: "history",
      title: "Read Castle history",
      description:
        "Return structured Castle history records, newest records last.",
      inputSchema: {
        limit: z.number().int().positive().max(10_000).optional(),
      },
      invoke: ({ limit }) =>
        deps.history({ limit: limit as number | undefined }),
    },
    {
      name: "queue_status",
      title: "Read AFK queues",
      description:
        "Return ready-for-agent and ready-for-human queue candidates.",
      inputSchema: {},
      invoke: () => deps.queueStatus(),
    },
    {
      name: "gate_run",
      title: "Run AFK feedback gate",
      description:
        "MUTATING: materialize a branch when needed, execute its package-scoped feedback checks, and return the structured verdict.",
      inputSchema: {
        worktree: z.string().min(1).optional(),
        branch: z.string().min(1).optional(),
        base: z.string().min(1).optional(),
        changedFiles: z.array(z.string().min(1)).optional(),
      },
      invoke: (input) => {
        const value = input as unknown as GateRunInput;
        if ((value.worktree === undefined) === (value.branch === undefined)) {
          throw new Error("exactly one of worktree or branch is required");
        }
        return deps.gateRun(value);
      },
    },
    {
      name: "gate_baseline_status",
      title: "Read AFK gate baseline status",
      description:
        "Return the open main-red repair record that represents the current feedback baseline status.",
      inputSchema: {},
      invoke: () => deps.gateBaselineStatus(),
    },
    {
      name: "land_branch",
      title: "Land validated AFK branch",
      description:
        "MUTATING: call the canonical landing operation for a branch whose feedback gate passed.",
      inputSchema: {
        issue: z.number().int().positive(),
        title: z.string().min(1),
        branch: z.string().min(1),
        base: z.string().min(1),
        gatePassed: z.literal(true),
        openPr: z.boolean().optional(),
        trunk: z.string().min(1).optional(),
        validatedBranchTip: z.string().min(1).optional(),
      },
      invoke: (input) => deps.landBranch(input as unknown as LandBranchInput),
    },
    {
      name: "cascade_status",
      title: "Read landing cascade status",
      description:
        "Return workers currently in the post-landing cascade phase.",
      inputSchema: {},
      invoke: () => deps.cascadeStatus(),
    },
    {
      name: "claim_status",
      title: "Read issue claims",
      description:
        "Return parsed claim records for one issue, excluding unrelated discussion.",
      inputSchema: { issue: z.number().int().positive() },
      invoke: ({ issue }) => deps.claimStatus({ issue: issue as number }),
    },
    {
      name: "claim_release",
      title: "Release issue claim",
      description:
        "MUTATING: append a concede marker that releases one worker claim.",
      inputSchema: {
        issue: z.number().int().positive(),
        worker: z.string().min(1),
        runner: z.string().min(1).optional(),
      },
      invoke: (input) =>
        deps.claimRelease(input as unknown as ClaimReleaseInput),
    },
    {
      name: "worktree_list",
      title: "List managed worktrees",
      description:
        "Enumerate worktrees in the canonical .red/tmp/worktrees lanes.",
      inputSchema: {},
      invoke: () => deps.worktreeList(),
    },
    {
      name: "worktree_remove",
      title: "Remove managed worktree",
      description:
        "MUTATING: force-remove one worktree only when it resolves inside a canonical .red/tmp/worktrees lane.",
      inputSchema: { worktree: z.string().min(1) },
      invoke: ({ worktree }) =>
        deps.worktreeRemove({ worktree: worktree as string }),
    },
  ];
}
