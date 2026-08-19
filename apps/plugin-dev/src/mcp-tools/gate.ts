import { z } from "zod/v3";
import type { CastleMcpTool } from "./tool.js";

export interface GateRunInput {
  branch: string;
  base?: string;
}

export interface GateDependencies {
  gateRun(input: GateRunInput): Promise<unknown>;
}

export function createGateTools(deps: GateDependencies): CastleMcpTool[] {
  return [
    {
      name: "gate_run",
      title: "Run the AFK gate",
      description:
        "MUTATING: materialize the branch's feedback worktree and run the package-scoped validation gate against it.",
      dangerClass: "mutating",
      inputSchema: {
        branch: z.string().min(1),
        base: z.string().min(1).optional(),
      },
      invoke: (input) => deps.gateRun(input as unknown as GateRunInput),
    },
  ];
}
