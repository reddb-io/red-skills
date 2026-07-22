import { z } from "zod/v3";
import type { CastleMcpTool } from "./tool.js";

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

export interface ObservabilityDependencies {
  logs(input: LogsInput): Promise<unknown>;
  workerVitals(input: WorkerVitalsInput): Promise<unknown>;
  dashboard(input: { periodDays: number }): Promise<unknown>;
  monitor(): Promise<unknown>;
  history(input: { limit?: number }): Promise<unknown>;
  queueStatus(): Promise<unknown>;
  eventsSince(input: EventsSinceInput): Promise<unknown>;
}

export function createObservabilityTools(
  deps: ObservabilityDependencies,
): CastleMcpTool[] {
  return [
    {
      name: "logs",
      title: "Read Castle logs",
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
      name: "worker_vitals",
      title: "Read worker vitals",
      description:
        "Return the liveness-qualified state of local workers. Defaults to live workers only; pass `live_only: false` to include stopped/dead workers. Pass `fields` to project top-level keys.",
      inputSchema: {
        live_only: z.boolean().default(true),
        fields: z.array(z.string().min(1)).optional(),
      },
      invoke: (input) =>
        deps.workerVitals({
          live_only: (input.live_only ?? true) as boolean,
          fields: input.fields as string[] | undefined,
        }),
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
      name: "events_since",
      title: "Poll events since cursor",
      description:
        "Return castle history events and worker lane records after an opaque cursor, plus the next cursor. Omit cursor to get a fresh baseline cursor with no events. Unknown or expired cursors are refused with a re-baseline prompt.",
      inputSchema: {
        cursor: z.string().min(1).optional(),
      },
      invoke: (input) =>
        deps.eventsSince({ cursor: input.cursor as string | undefined }),
    },
  ];
}
