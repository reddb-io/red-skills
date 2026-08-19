import { z } from "zod/v3";
import {
  queueStatusContract,
  type MonitorOutput,
  type QueueStatusOutput,
  type WorkerVitalsOutput,
  type WorkerVitalsProjectedOutput,
} from "./contracts.js";
import type { CastleMcpTool } from "./tool.js";
import { workSelectorShape, type WorkSelectorInput } from "./project.js";

export interface LogsInput {
  lane: "worker" | "supervisor" | "monitor" | "liveness";
  id: string;
  limit?: number;
  kind?: string;
}

export interface WorkerVitalsInput {
  live_only?: boolean;
  fields?: string[];
}

export interface EventsSinceInput {
  cursor?: string;
}

export interface QueueStatusInput {
  selector?: WorkSelectorInput;
}

export interface ObservabilityDependencies {
  logs(input: LogsInput): Promise<unknown>;
  /** Returns the projected shape when `input.fields` narrows the records. */
  workerVitals(
    input: WorkerVitalsInput,
  ): Promise<WorkerVitalsOutput | WorkerVitalsProjectedOutput>;
  dashboard(input: { periodDays: number }): Promise<unknown>;
  monitor(): Promise<MonitorOutput>;
  history(input: { limit?: number }): Promise<unknown>;
  queueStatus(input?: QueueStatusInput): Promise<QueueStatusOutput>;
  eventsSince(input: EventsSinceInput): Promise<unknown>;
}

export function createObservabilityTools(
  deps: ObservabilityDependencies,
): CastleMcpTool[] {
  return [
    {
      name: "logs",
      title: "Read redskilled logs",
      description:
        "Return the newest CastleLaneRecord entries from one structured lane; bounded by `limit` (default 200, max 10 000). Pass `kind` to filter before the limit.",
      inputSchema: {
        lane: z.enum(["worker", "supervisor", "monitor", "liveness"]),
        id: z.string().min(1),
        limit: z.number().int().positive().max(10_000).default(200),
        kind: z.string().optional(),
      },
      invoke: (input) => deps.logs(input as unknown as LogsInput),
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
      name: "history",
      title: "Read redskilled history",
      description:
        "Return structured AFK history records, newest records last.",
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
        "Return ready-for-agent and ready-for-human queue candidates, retaining successful candidates and naming partial trust-read failures as a degraded result. Pass `selector` to preview the producer's scoped view of the ready queue (same facets as its work selector, e.g. tags/user).",
      inputSchema: {
        selector: z.object(workSelectorShape).optional(),
      },
      outputContract: queueStatusContract,
      invoke: (input) =>
        deps.queueStatus({
          selector: input.selector as WorkSelectorInput | undefined,
        }),
    },
    {
      name: "events_since",
      title: "Poll events since cursor",
      description:
        "Return AFK history events and Worker lane records after an opaque cursor, plus the next cursor. Omit cursor to get a fresh baseline cursor with no events. Unknown or expired cursors are refused with a re-baseline prompt.",
      inputSchema: {
        cursor: z.string().min(1).optional(),
      },
      invoke: (input) =>
        deps.eventsSince({ cursor: input.cursor as string | undefined }),
    },
  ];
}
