import { z } from "zod/v3";
import type { CastleMcpTool } from "./tool.js";

export interface FleetSelectorInput {
  spec?: number;
  lane?: string;
  label?: string;
  issues?: number[];
}

export interface FleetCreateInput {
  name: string;
  runner: string;
  target: number;
  selector?: FleetSelectorInput;
  config?: Record<string, string | number | boolean>;
  base?: string;
}

export interface FleetEditInput {
  name: string;
  runner?: string;
  target?: number;
  selector?: FleetSelectorInput;
  config?: Record<string, string | number | boolean>;
  base?: string;
}

export interface FleetNameInput {
  name?: string;
}

export interface FleetRegisterInput {
  name?: string;
  runner: string;
  selector?: FleetSelectorInput;
  config?: Record<string, string | number | boolean>;
  base?: string;
}

export interface FleetDependencies {
  fleetList(): Promise<unknown>;
  fleetStatus(input: FleetNameInput): Promise<unknown>;
  fleetCreate(input: FleetCreateInput): Promise<unknown>;
  fleetEdit(input: FleetEditInput): Promise<unknown>;
  fleetStop(input: FleetNameInput): Promise<unknown>;
  fleetRegister(input: FleetRegisterInput): Promise<unknown>;
}

const fleetSelectorShape = {
  spec: z.number().int().positive().optional(),
  lane: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  issues: z.array(z.number().int().positive()).optional(),
};

const fleetConfig = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]),
);

export function createFleetTools(deps: FleetDependencies): CastleMcpTool[] {
  return [
    {
      name: "fleet_list",
      title: "List AFK fleets",
      description: "List every registered named AFK fleet profile.",
      inputSchema: {},
      invoke: () => deps.fleetList(),
    },
    {
      name: "fleet_status",
      title: "Get AFK fleet status",
      description:
        "Return structured supervisor, slots, churn, and live-worker status for a named fleet.",
      inputSchema: { fleet: z.string().min(1).optional() },
      invoke: ({ fleet }) =>
        deps.fleetStatus({ name: fleet as string | undefined }),
    },
    {
      name: "fleet_create",
      title: "Create AFK fleet",
      description:
        "MUTATING: persist a named fleet profile and spawn its supervisor.",
      inputSchema: {
        name: z.string().min(1),
        runner: z.string().min(1),
        target: z.number().int().min(0).default(2),
        selector: z.object(fleetSelectorShape).optional(),
        config: fleetConfig.optional(),
        base: z.string().min(1).optional(),
      },
      invoke: (input) => deps.fleetCreate(input as unknown as FleetCreateInput),
    },
    {
      name: "fleet_edit",
      title: "Edit AFK fleet",
      description:
        "MUTATING: update a named fleet profile and send a live resize directive when requested.",
      inputSchema: {
        name: z.string().min(1),
        runner: z.string().min(1).optional(),
        target: z.number().int().min(0).optional(),
        selector: z.object(fleetSelectorShape).optional(),
        config: fleetConfig.optional(),
        base: z.string().min(1).optional(),
      },
      invoke: (input) => deps.fleetEdit(input as unknown as FleetEditInput),
    },
    {
      name: "fleet_stop",
      title: "Stop AFK fleet",
      description: "MUTATING: stop one named fleet and its detached workers.",
      inputSchema: { fleet: z.string().min(1).optional() },
      invoke: ({ fleet }) =>
        deps.fleetStop({ name: fleet as string | undefined }),
    },
    {
      name: "fleet_register",
      title: "Adopt AFK fleet",
      description:
        "MUTATING: persist a profile for an already-running supervisor without restarting it.",
      inputSchema: {
        name: z.string().min(1).optional(),
        runner: z.string().min(1),
        selector: z.object(fleetSelectorShape).optional(),
        config: fleetConfig.optional(),
        base: z.string().min(1).optional(),
      },
      invoke: (input) => deps.fleetRegister(input as unknown as FleetRegisterInput),
    },
  ];
}
