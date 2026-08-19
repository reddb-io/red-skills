import { z } from "zod/v3";
import type { CastleMcpTool } from "./tool.js";

export interface ClaimIssueInput {
  /** Single-issue form (back-compat). Exactly one of `issue`/`issues` is set. */
  issue?: number;
  /** Batch form (#2369): one call, response keyed per issue. */
  issues?: number[];
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
        "Return the parsed claim marker records and current holder for one issue (`issue`) " +
        "or a batch (`issues`), keyed per issue.",
      inputSchema: {
        issue: z.number().int().positive().optional(),
        issues: z.array(z.number().int().positive()).min(1).optional(),
      },
      invoke: (input) => deps.claimStatus(input as ClaimIssueInput),
    },
    {
      name: "claim_release",
      title: "Release AFK claim",
      description:
        "MUTATING: post a concede marker for every un-conceded claim holder so the issue (`issue`) " +
        "or each issue in a batch (`issues`) becomes claimable again.",
      inputSchema: {
        issue: z.number().int().positive().optional(),
        issues: z.array(z.number().int().positive()).min(1).optional(),
      },
      invoke: (input) => deps.claimRelease(input as ClaimIssueInput),
    },
  ];
}
