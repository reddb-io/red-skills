import { z } from "zod/v3";
import type { CastleMcpTool } from "./tool.js";

export interface WaitStartInput {
  kind: "pr" | "run" | "release" | "cmd";
  target: string;
  timeout_ms?: number;
  reason?: string;
}

export interface WaitStatusInput {
  id: string;
}

export interface WaitDependencies {
  waitStart(input: WaitStartInput): Promise<unknown>;
  waitList(): Promise<unknown>;
  waitStatus(input: WaitStatusInput): Promise<unknown>;
}

export function createWaitTools(deps: WaitDependencies): CastleMcpTool[] {
  return [
    {
      name: "wait_start",
      title: "Start rsp wait",
      description:
        "MUTATING: spawn a detached rsp wait (pr | run | release | cmd) and return its registry id.",
      inputSchema: {
        kind: z.enum(["pr", "run", "release", "cmd"]),
        target: z.string().min(1),
        timeout_ms: z.number().int().positive().optional(),
        reason: z.string().optional(),
      },
      invoke: (input) => deps.waitStart(input as unknown as WaitStartInput),
    },
    {
      name: "wait_list",
      title: "List active rsp waits",
      description: "Return the active-wait registry from .red/tmp/waits.",
      inputSchema: {},
      invoke: () => deps.waitList(),
    },
    {
      name: "wait_status",
      title: "Read rsp wait status",
      description:
        "Return the registry entry for a running wait or the sealed result envelope for a finished one.",
      inputSchema: {
        id: z.string().min(1),
      },
      invoke: ({ id }) => deps.waitStatus({ id: id as string }),
    },
  ];
}
