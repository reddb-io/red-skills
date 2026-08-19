import { z } from "zod/v3";
import type { CastleMcpTool } from "./tool.js";
import {
  dispatchInput,
  dispatchShape,
  workerInputRefusal,
  type WorkerDispatchInput,
} from "./worker.js";

export interface RunnerDetectInput {
  runner?: string;
}

export interface WorkerSteerInput {
  worker: string;
  text: string;
}

export interface WorkerSteerStatusInput {
  worker: string;
}

export interface WorkerRequestInput extends WorkerDispatchInput {
  text: string;
}

export interface RunnerDependencies {
  runnerList(): Promise<unknown>;
  runnerDetect(input: RunnerDetectInput): Promise<unknown>;
  runnerSteer(input: WorkerSteerInput): Promise<unknown>;
  steerStatus(input: WorkerSteerStatusInput): Promise<unknown>;
  workerRequest(input: WorkerRequestInput): Promise<unknown>;
}

/**
 * The runner domain owns runner selection plus the two request-injection
 * tools — `runner_steer` (into a live worker) and `worker_request` (into a
 * spawn-time handoff) — which are the same capability at two lifecycle points.
 */
export function createRunnerTools(deps: RunnerDependencies): CastleMcpTool[] {
  return [
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
      name: "runner_steer",
      title: "Steer live AFK worker",
      description:
        "MUTATING: write a live-steer request into a running worker's next iteration.",
      inputSchema: {
        worker: z.string().min(1),
        text: z.string().min(1),
      },
      invoke: (input) => deps.runnerSteer(input as unknown as WorkerSteerInput),
    },
    {
      name: "steer_status",
      title: "Read steer status",
      description:
        "Return the live-steer status for a worker: none (no steer ever written), pending (written, not yet consumed), or consumed (consumed at a specific iteration).",
      inputSchema: {
        worker: z.string().min(1),
      },
      invoke: (input) =>
        deps.steerStatus(input as unknown as WorkerSteerStatusInput),
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
      invoke: (input) => {
        let parsed: WorkerDispatchInput;
        try {
          parsed = dispatchInput(input);
        } catch (err) {
          return Promise.resolve(workerInputRefusal(err));
        }
        return deps.workerRequest({ ...parsed, text: input.text as string });
      },
    },
  ];
}
