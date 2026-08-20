// standing-orders — rs_dev verbs to show and append standing orders
import { z } from "zod/v3";
import type { CastleMcpTool } from "./tool.js";

export interface StandingOrdersShowInput {
  project_label?: string;
}

export interface StandingOrdersAppendInput {
  text: string;
  project_label?: string;
}

export interface StandingOrdersDependencies {
  standingOrdersShow(input: StandingOrdersShowInput): Promise<unknown>;
  standingOrdersAppend(input: StandingOrdersAppendInput): Promise<unknown>;
}

export function createStandingOrdersTools(deps: StandingOrdersDependencies): CastleMcpTool[] {
  return [
    {
      name: "standing_orders_show",
      title: "Show standing orders for this project",
      description:
        "READ-ONLY: return all standing orders for this project. Standing orders are an append-only, numbered register injected verbatim into every Worker brief.",
      inputSchema: {
        project_label: z.string().min(1).optional().describe("Override the current project label"),
      },
      invoke: (input) => deps.standingOrdersShow(input as StandingOrdersShowInput),
    },
    {
      name: "standing_orders_append",
      title: "Append a standing order",
      description:
        "MUTATING: append a new standing order to this project's register. The order is injected verbatim into every Worker brief at admission and on resume. Append is append-only — existing orders are never mutated or renumbered.",
      inputSchema: {
        text: z.string().min(1).describe("The standing order text"),
        project_label: z.string().min(1).optional().describe("Override the current project label"),
      },
      invoke: (input) => deps.standingOrdersAppend(input as unknown as StandingOrdersAppendInput),
    },
  ];
}
