import { z } from "zod/v3";
import type { CastleMcpTool } from "./tool.js";

export interface DailyReviewInput {
  // rooted at the server cwd — no explicit repo needed
}

export interface WeeklyReviewInput {
  // rooted at the server cwd — no explicit repo needed
}

export interface TriageToolInput {
  issue: number;
  decision: "ready-for-agent" | "needs-info" | "ready-for-human" | "wontfix";
  summon?: boolean;
  repo?: string;
}

export interface RespondToolInput {
  body: string;
  number: number;
  author?: string;
  is_pr?: boolean;
  runner?: string;
  repo?: string;
}

export interface ReviewDependencies {
  dailyReview(input: DailyReviewInput): Promise<unknown>;
  weeklyReview(input: WeeklyReviewInput): Promise<unknown>;
  triage(input: TriageToolInput): Promise<unknown>;
  respond(input: RespondToolInput): Promise<unknown>;
}

export function createReviewTools(deps: ReviewDependencies): CastleMcpTool[] {
  return [
    {
      name: "daily_review",
      title: "Build daily activity review",
      description:
        "Return the structured daily activity review report for the local window.",
      inputSchema: {},
      invoke: () => deps.dailyReview({}),
    },
    {
      name: "weekly_review",
      title: "Build weekly activity review",
      description:
        "Return the structured weekly activity review report for the local window.",
      inputSchema: {},
      invoke: () => deps.weeklyReview({}),
    },
    {
      name: "triage",
      title: "Apply triage decision",
      description:
        "MUTATING: apply the decided triage transition to one issue, gated by the per-repo trust policy.",
      inputSchema: {
        issue: z.number().int().positive(),
        decision: z.enum([
          "ready-for-agent",
          "needs-info",
          "ready-for-human",
          "wontfix",
        ]),
        summon: z.boolean().optional(),
        repo: z.string().min(1).optional(),
      },
      invoke: (input) => deps.triage(input as unknown as TriageToolInput),
    },
    {
      name: "respond",
      title: "Handle comment event",
      description:
        "MUTATING: parse a /dev comment summon, authorize the commenter, and route the advisory or mutation verb.",
      inputSchema: {
        body: z.string(),
        number: z.number().int().positive(),
        author: z.string().min(1).optional(),
        is_pr: z.boolean().optional(),
        runner: z.string().min(1).optional(),
        repo: z.string().min(1).optional(),
      },
      invoke: (input) => deps.respond(input as unknown as RespondToolInput),
    },
  ];
}
