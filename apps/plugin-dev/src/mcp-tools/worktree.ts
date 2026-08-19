import { z } from "zod/v3";
import type { CastleMcpTool } from "./tool.js";

export interface WorktreeRemoveInput {
  path: string;
}

export interface WorktreeDependencies {
  worktreeList(): Promise<unknown>;
  worktreeRemove(input: WorktreeRemoveInput): Promise<unknown>;
}

export function createWorktreeTools(
  deps: WorktreeDependencies,
): CastleMcpTool[] {
  return [
    {
      name: "worktree_list",
      title: "List disposable worktrees",
      description:
        "Enumerate every checkout under the disposable `.red/tmp/worktrees/*` lanes.",
      inputSchema: {},
      invoke: () => deps.worktreeList(),
    },
    {
      name: "worktree_remove",
      title: "Remove disposable worktree",
      description:
        "MUTATING: remove one checkout under the disposable `.red/tmp/worktrees/*` lanes.",
      inputSchema: { path: z.string().min(1) },
      invoke: ({ path }) => deps.worktreeRemove({ path: path as string }),
    },
  ];
}
