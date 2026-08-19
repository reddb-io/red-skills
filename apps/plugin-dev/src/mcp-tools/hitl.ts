import { z } from "zod/v3";
import type { CastleMcpTool } from "./tool.js";

/** The closed decision vocabulary for one human call on a parked issue. */
export const HITL_DECISIONS = ["requeue", "retake", "park", "close"] as const;
export type HitlDecision = (typeof HITL_DECISIONS)[number];

export interface HitlResolveInput {
  issue: number;
  decision: HitlDecision;
  rationale: string;
}

export interface HitlDependencies {
  hitlResolve(input: HitlResolveInput): Promise<unknown>;
}

export function createHitlTools(deps: HitlDependencies): CastleMcpTool[] {
  return [
    {
      name: "hitl_resolve",
      title: "Resolve parked issue with a human decision",
      description:
        "MUTATING: encode one human decision on a parked issue atomically — " +
        "requeue (concede dangling claims, strip park labels, ready-for-agent), " +
        "retake (route to the no-agent landing lane), park (keep ready-for-human, record why), " +
        "or close. The rationale is posted as an issue comment for the audit trail.",
      inputSchema: {
        issue: z.number().int().positive(),
        decision: z.enum(HITL_DECISIONS),
        rationale: z.string().min(1),
      },
      invoke: (input) => deps.hitlResolve(input as unknown as HitlResolveInput),
    },
  ];
}
