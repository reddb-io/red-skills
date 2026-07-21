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

export interface WorkerDispatchInput {
  issue?: number;
  demand?: string;
  runner?: string;
  mode?: "no-mistakes" | "direct-PR" | "local-only";
}

export interface WorkerStatusInput {
  worker?: string;
}

export interface WorkerStopInput {
  worker: string;
  recycle: boolean;
}

export interface RunnerDetectInput {
  runner?: string;
}

export interface WorkerRequestInput extends WorkerDispatchInput {
  text: string;
}

export interface RequeueToolInput {
  issue: number;
  guidance: string;
  repo?: string;
  dryRun?: boolean;
  adoptBranch?: string;
}

export interface RetakeToolInput {
  issue: number;
  repo?: string;
  prLimit?: number;
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
  workerDispatch(input: WorkerDispatchInput): Promise<unknown>;
  workerStatus(input: WorkerStatusInput): Promise<unknown>;
  workerStop(input: WorkerStopInput): Promise<unknown>;
  runnerList(): Promise<unknown>;
  runnerDetect(input: RunnerDetectInput): Promise<unknown>;
  workerRequest(input: WorkerRequestInput): Promise<unknown>;
  requeue(input: RequeueToolInput): Promise<unknown>;
  retake(input: RetakeToolInput): Promise<unknown>;
  reap(): Promise<unknown>;
  unblockSweep(): Promise<unknown>;
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

const dispatchShape = {
  issue: z.number().int().positive().optional(),
  demand: z.string().min(1).optional(),
  runner: z.string().min(1).optional(),
  mode: z.enum(["no-mistakes", "direct-PR", "local-only"]).optional(),
};

function dispatchInput(input: Record<string, unknown>): WorkerDispatchInput {
  const value = input as unknown as WorkerDispatchInput;
  if ((value.issue === undefined) === (value.demand === undefined)) {
    throw new Error("exactly one of issue or demand is required");
  }
  if (value.issue !== undefined && value.mode !== undefined) {
    throw new Error("mode is only valid for demand dispatches");
  }
  return value;
}

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
      name: "worker_dispatch",
      title: "Dispatch AFK worker",
      description:
        "MUTATING: run one tracked issue or mint and run one disposable demand through the AFK worker lifecycle.",
      inputSchema: dispatchShape,
      invoke: (input) => deps.workerDispatch(dispatchInput(input)),
    },
    {
      name: "worker_status",
      title: "Read worker status",
      description:
        "Return normalized, liveness-qualified state for one worker or every local worker.",
      inputSchema: { worker: z.string().min(1).optional() },
      invoke: ({ worker }) =>
        deps.workerStatus({ worker: worker as string | undefined }),
    },
    {
      name: "worker_stop",
      title: "Stop AFK worker",
      description: "MUTATING: terminate one worker process tree.",
      inputSchema: { worker: z.string().min(1) },
      invoke: ({ worker }) =>
        deps.workerStop({ worker: worker as string, recycle: false }),
    },
    {
      name: "worker_recycle",
      title: "Recycle AFK worker",
      description:
        "MUTATING: terminate one fleet worker so its supervisor can replace the slot.",
      inputSchema: { worker: z.string().min(1) },
      invoke: ({ worker }) =>
        deps.workerStop({ worker: worker as string, recycle: true }),
    },
    {
      name: "runner_list",
      title: "List AFK runners",
      description: "Return the canonical runner specification registry.",
      inputSchema: {},
      invoke: () => deps.runnerList(),
    },
    {
      name: "runner_detect",
      title: "Detect AFK runner",
      description:
        "Resolve the runner selected by an explicit override or the current host environment.",
      inputSchema: { runner: z.string().min(1).optional() },
      invoke: ({ runner }) =>
        deps.runnerDetect({ runner: runner as string | undefined }),
    },
    {
      name: "worker_request",
      title: "Dispatch worker with request",
      description:
        "MUTATING: dispatch a new worker and inject a special request into its spawn-time handoff.",
      inputSchema: {
        ...dispatchShape,
        text: z.string().min(1),
      },
      invoke: (input) =>
        deps.workerRequest({
          ...dispatchInput(input),
          text: input.text as string,
        }),
    },
    {
      name: "requeue",
      title: "Requeue AFK issue",
      description:
        "MUTATING: apply the complete parked-issue requeue transition and record human guidance.",
      inputSchema: {
        issue: z.number().int().positive(),
        guidance: z.string().min(1),
        repo: z.string().min(1).optional(),
        dryRun: z.boolean().optional(),
        adoptBranch: z.string().min(1).optional(),
      },
      invoke: (input) => deps.requeue(input as unknown as RequeueToolInput),
    },
    {
      name: "retake",
      title: "Recommend AFK retake",
      description:
        "Return the structured issue, PR, branch, worktree, worker-state, and recommended-next-action report.",
      inputSchema: {
        issue: z.number().int().positive(),
        repo: z.string().min(1).optional(),
        prLimit: z.number().int().positive().max(1_000).optional(),
      },
      invoke: (input) => deps.retake(input as unknown as RetakeToolInput),
    },
    {
      name: "reap",
      title: "Reap AFK branches",
      description:
        "MUTATING: classify and delete stale local and remote AFK branches.",
      inputSchema: {},
      invoke: () => deps.reap(),
    },
    {
      name: "unblock_sweep",
      title: "Sweep dependency blocks",
      description:
        "MUTATING: promote dependency-blocked issues whose requirements are all closed.",
      inputSchema: {},
      invoke: () => deps.unblockSweep(),
    },
  ];
}
