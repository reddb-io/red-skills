import { z } from "zod/v3";
import type { CastleMcpTool } from "./tool.js";

export interface MergeArmInput {
  pr: number;
}

export interface MergeDependencies {
  mergeArm(input: MergeArmInput): Promise<unknown>;
  mergeStatus(): Promise<unknown>;
  mergeRelease(input: MergeArmInput): Promise<unknown>;
}

export function createMergeTools(deps: MergeDependencies): CastleMcpTool[] {
  return [
    {
      name: "merge_arm",
      title: "Arm PR for the merge driver",
      description:
        "MUTATING: hand one open PR to the project merge driver — it owns the PR to a terminal state " +
        "(update-branch when BEHIND, merge-commit once green at head, bounded retries, " +
        "needs-medic/needs-human classification) without GitHub native auto-merge.",
      inputSchema: { pr: z.number().int().positive() },
      invoke: ({ pr }) => deps.mergeArm({ pr: pr as number }),
    },
    {
      name: "merge_status",
      title: "Read merge driver state",
      description:
        "Return the driver's durable per-PR records: armed set, attempts, last observed state, " +
        "and terminal classifications.",
      inputSchema: {},
      invoke: () => deps.mergeStatus(),
    },
    {
      name: "merge_release",
      title: "Release PR from the merge driver",
      description:
        "MUTATING: stop driver ownership of one PR. The record is kept as released for observability.",
      inputSchema: { pr: z.number().int().positive() },
      invoke: ({ pr }) => deps.mergeRelease({ pr: pr as number }),
    },
  ];
}
