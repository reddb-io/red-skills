import { z } from "zod/v3";
import type { CastleMcpTool } from "./tool.js";

export interface ClaimIssueInput {
  issue: number;
}

export interface ClaimDependencies {
  claimStatus(input: ClaimIssueInput): Promise<unknown>;
  claimRelease(input: ClaimIssueInput): Promise<unknown>;
}

export function createClaimTools(deps: ClaimDependencies): CastleMcpTool[] {
  return [
    {
      name: "claim_status",
      title: "Read AFK claim",
      description:
        "Return the parsed claim marker records for one issue and the worker currently holding it.",
      inputSchema: { issue: z.number().int().positive() },
      invoke: ({ issue }) => deps.claimStatus({ issue: issue as number }),
    },
    {
      name: "claim_release",
      title: "Release AFK claim",
      description:
        "MUTATING: post a concede marker for every un-conceded claim holder so the issue becomes claimable again.",
      inputSchema: { issue: z.number().int().positive() },
      invoke: ({ issue }) => deps.claimRelease({ issue: issue as number }),
    },
  ];
}
