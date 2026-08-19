// project.ts — the project lifecycle tool domain, after the Fleet's removal.
//
// These tools replace the `fleet_*` surface one for one where a capability
// survived, and drop the two that only ever existed to operate the named-fleet
// registry (`fleet_list`, `fleet_register`) — with no registry there is no
// second fleet to list and no profile to adopt. A project has exactly one
// demand producer, so every tool here addresses *the* project rather than a
// name (ADR 0130, amending ADR 0120's tool surface).
//
// What survived the removal is the work policy: the selector, the runner and
// the base branch are handed over at start and re-aimed by resize. Since ADR 0130
// Amendment 3 they are handed to the HOST as a registration rather than to a
// supervisor the project spawned — the MCP registers, the daemon drives (#2902).

import { z } from "zod/v3";
import { refuseFleetNaming } from "./extinct-nouns.js";
import { projectStatusContract, type ProjectStatusOutput } from "./contracts.js";
import {
  deprecatedStatusAlias,
  deprecatedStatusAliasContract,
} from "./status.js";
import type { CastleMcpTool } from "./tool.js";
import { DEFAULT_FLEET_WIDTH } from "@reddb-io/shared/default-fleet-width.js";

export interface WorkSelectorInput {
  spec?: number;
  lane?: string;
  label?: string;
  issues?: number[];
  tags?: string[];
  user?: string;
}

export interface ProjectStartInput {
  runner: string;
  target: number;
  selector?: WorkSelectorInput;
  config?: Record<string, string | number | boolean>;
  base?: string;
}

export interface ProjectDrainInput {
  runner?: string;
  target?: number;
}

export interface ProjectActivationOutput {
  eligible: boolean;
  project: string;
  runner: string;
  target: number;
  standing: boolean;
  config: string;
}

export interface ProjectResizeInput {
  runner?: string;
  target?: number;
  selector?: WorkSelectorInput;
  config?: Record<string, string | number | boolean>;
  base?: string;
}

export interface ProjectStopInput {
  force?: boolean;
}

export interface ProjectResetInput {
  latch: "project-birth-breaker";
}

export interface ProjectDependencies {
  projectActivation(): Promise<ProjectActivationOutput>;
  projectStatus(): Promise<ProjectStatusOutput>;
  drain(input: ProjectDrainInput): Promise<unknown>;
  projectStart(input: ProjectStartInput): Promise<unknown>;
  projectResize(input: ProjectResizeInput): Promise<unknown>;
  projectReset(input: ProjectResetInput): Promise<unknown>;
  projectStop(input: ProjectStopInput): Promise<unknown>;
}

const workSelectorShape = {
  spec: z.number().int().positive().optional(),
  lane: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  issues: z.array(z.number().int().positive()).optional(),
  tags: z.array(z.string().min(1)).optional(),
  user: z.string().min(1).optional(),
};

export { workSelectorShape };

const workConfig = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]),
);

/**
 * The one input every project tool still declares about fleets: a name, so a
 * stale caller is told what replaced it instead of having its name silently
 * stripped and its request executed against the wrong thing. It is a migration
 * answer, never a capability — any value at all is refused.
 */
const removedFleetName = z
  .string()
  .optional()
  .describe("REMOVED: naming a fleet is refused; a project has one producer.");

export function createProjectTools(deps: ProjectDependencies): CastleMcpTool[] {
  return [
    {
      name: "project_activation",
      title: "Preview this project's redskilled activation",
      description:
        "READ-ONLY: report whether this project opted into RedSkills and the canonical runner and target a no-argument drain would register.",
      inputSchema: {},
      invoke: () => deps.projectActivation(),
    },
    {
      name: "project_status",
      title: "Deprecated project status alias",
      description:
        "DEPRECATED: use status { scope: project }. Returns the project answer and names its replacement.",
      inputSchema: { fleet: removedFleetName },
      outputContract: deprecatedStatusAliasContract(projectStatusContract),
      invoke: async ({ fleet }) => {
        refuseFleetNaming(fleet);
        return deprecatedStatusAlias(
          "project_status",
          "project",
          await deps.projectStatus(),
        );
      },
    },
    {
      name: "drain",
      title: "Make this project drain",
      description:
        "MUTATING: ensure the daemon is reachable and this project is registered. Omitted runner and target resolve from this project's canonical RedSkills configuration; repeated calls report what was kept.",
      inputSchema: {
        runner: z.string().min(1).optional(),
        target: z.number().int().min(0).optional(),
      },
      invoke: async (input) => deps.drain(input as unknown as ProjectDrainInput),
    },
    {
      name: "project_start",
      title: "Start this project's workers",
      description:
        "MUTATING: register this project with the host daemon — a runner, a target width, and its work policy. " +
        "Registers rather than launches: the project contributes a record, never a process of its own.",
      inputSchema: {
        runner: z.string().min(1),
        target: z.number().int().min(0).default(DEFAULT_FLEET_WIDTH),
        selector: z.object(workSelectorShape).optional(),
        config: workConfig.optional(),
        base: z.string().min(1).optional(),
        fleet: removedFleetName,
      },
      invoke: async (input) => {
        refuseFleetNaming(input.fleet);
        return deps.projectStart(input as unknown as ProjectStartInput);
      },
    },
    {
      name: "project_resize",
      title: "Re-aim this project's workers",
      description:
        "MUTATING: change this project's target width, runner, or work policy and send the live directive.",
      inputSchema: {
        runner: z.string().min(1).optional(),
        target: z.number().int().min(0).optional(),
        selector: z.object(workSelectorShape).optional(),
        config: workConfig.optional(),
        base: z.string().min(1).optional(),
        fleet: removedFleetName,
      },
      invoke: async (input) => {
        refuseFleetNaming(input.fleet);
        return deps.projectResize(input as unknown as ProjectResizeInput);
      },
    },
    {
      name: "project_reset",
      title: "Reset project execution latch",
      description:
        "MUTATING: clear a named in-memory latch for this project so autonomous demand may retry immediately.",
      inputSchema: {
        latch: z.literal("project-birth-breaker"),
        fleet: removedFleetName,
      },
      invoke: async ({ latch, fleet }) => {
        refuseFleetNaming(fleet);
        return deps.projectReset({ latch: latch as "project-birth-breaker" });
      },
    },
    {
      name: "project_stop",
      title: "Stop this project's workers",
      description:
        "MUTATING: stop this project's work and give its registration back; force hard teardown explicitly.",
      inputSchema: { force: z.boolean().optional(), fleet: removedFleetName },
      invoke: async ({ force, fleet }) => {
        refuseFleetNaming(fleet);
        return deps.projectStop({ force: force as boolean | undefined });
      },
    },
  ];
}
