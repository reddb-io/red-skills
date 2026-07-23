import { z } from "zod/v3";
import type { CastleMcpTool } from "./tool.js";

export interface WorkerDispatchInput {
  issue?: number;
  demand?: string;
  runner?: string;
  mode?: "no-mistakes" | "direct-PR" | "local-only" | "scout";
}

export interface WorkerStatusInput {
  worker?: string;
  live_only?: boolean;
  fields?: string[];
}

export interface WorkerStopInput {
  worker: string;
  recycle: boolean;
}

export interface WorkerInputRefusal {
  refused: true;
  reason: string;
}

export interface WorkerDependencies {
  workerDispatch(input: WorkerDispatchInput): Promise<unknown>;
  workerStatus(input: WorkerStatusInput): Promise<unknown>;
  workerStop(input: WorkerStopInput): Promise<unknown>;
}

/** Shared by `worker_dispatch` and the runner domain's `worker_request`. */
export const dispatchShape = {
  issue: z.number().int().positive().optional(),
  demand: z.string().min(1).optional(),
  runner: z.string().min(1).optional(),
  mode: z.enum(["no-mistakes", "direct-PR", "local-only", "scout"]).optional(),
};

export function dispatchInput(
  input: Record<string, unknown>,
): WorkerDispatchInput {
  const value = input as unknown as WorkerDispatchInput;
  if ((value.issue === undefined) === (value.demand === undefined)) {
    throw new Error("exactly one of issue or demand is required");
  }
  if (value.mode === "scout" && value.issue !== undefined) {
    throw new Error("mode: scout is demand-only — combine scout with demand, not issue");
  }
  if (value.issue !== undefined && value.mode !== undefined) {
    throw new Error("mode is only valid for demand dispatches");
  }
  return value;
}

export function createWorkerTools(deps: WorkerDependencies): CastleMcpTool[] {
  return [
    {
      name: "worker_dispatch",
      title: "Dispatch AFK worker",
      description:
        "MUTATING: run one tracked issue or mint and run one disposable demand through the AFK worker lifecycle.",
      inputSchema: dispatchShape,
      invoke: (input) => {
        let parsed: WorkerDispatchInput;
        try {
          parsed = dispatchInput(input);
        } catch (err) {
          return Promise.resolve<WorkerInputRefusal>({
            refused: true,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
        return deps.workerDispatch(parsed);
      },
    },
    {
      name: "worker_status",
      title: "Read worker status",
      description:
        "Return normalized, liveness-qualified state for one worker or every local worker. Defaults to live workers only; pass `live_only: false` to include stopped/dead workers.",
      inputSchema: {
        worker: z.string().min(1).optional(),
        live_only: z.boolean().default(true),
        fields: z.array(z.string().min(1)).optional(),
      },
      invoke: ({ worker, live_only, fields }) =>
        deps.workerStatus({
          worker: worker as string | undefined,
          live_only: (live_only ?? true) as boolean,
          fields: fields as string[] | undefined,
        }),
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
  ];
}
