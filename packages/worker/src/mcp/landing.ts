import { z } from "zod/v3";
import type { CastleMcpTool } from "./tool.js";

export interface LandBranchInput {
  issue: number;
  branch: string;
  base?: string;
  title?: string;
  openPr?: boolean;
}

export interface CascadeStatusInput {
  issue: number;
}

export interface LandingDependencies {
  landBranch(input: LandBranchInput): Promise<unknown>;
  cascadeStatus(input: CascadeStatusInput): Promise<unknown>;
}

export function createLandingTools(deps: LandingDependencies): CastleMcpTool[] {
  return [
    {
      name: "land_branch",
      title: "Land AFK branch",
      description:
        "MUTATING: land one validated worker branch into its base through the complete landing sequence.",
      dangerClass: "mutating",
      inputSchema: {
        issue: z.number().int().positive(),
        branch: z.string().min(1),
        base: z.string().min(1).optional(),
        title: z.string().min(1).optional(),
        openPr: z.boolean().optional(),
      },
      invoke: (input) => deps.landBranch(input as unknown as LandBranchInput),
    },
    {
      name: "cascade_status",
      title: "Read close cascade",
      description:
        "Return the dependents of one issue and which of them the close cascade would promote.",
      inputSchema: { issue: z.number().int().positive() },
      invoke: ({ issue }) => deps.cascadeStatus({ issue: issue as number }),
    },
  ];
}
