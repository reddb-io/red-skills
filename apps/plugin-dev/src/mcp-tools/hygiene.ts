import { z } from "zod/v3";
import type { CastleMcpTool } from "./tool.js";

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

export interface HygieneDependencies {
  requeue(input: RequeueToolInput): Promise<unknown>;
  retake(input: RetakeToolInput): Promise<unknown>;
  reap(): Promise<unknown>;
  unblockSweep(): Promise<unknown>;
}

export function createHygieneTools(deps: HygieneDependencies): CastleMcpTool[] {
  return [
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
