import { z } from "zod/v3";
import type { HostDependencies } from "./host.js";
import type { ObservabilityDependencies } from "./observability.js";
import type { ProjectDependencies } from "./project.js";
import {
  CASTLE_MCP_CONTRACT_VERSION,
  monitorOutputSchema,
  projectStatusOutputSchema,
  workerVitalsOutputSchema,
  workerVitalsProjectedOutputSchema,
  type CastleMcpOutputContract,
} from "./contracts.js";
import type { CastleMcpTool } from "./tool.js";
import type { WorkerDependencies } from "./worker.js";

export type StatusScope = "worker" | "project" | "host";

export interface StatusInput {
  scope: StatusScope;
  worker?: string;
  live_only?: boolean;
  fields?: string[];
}

export interface StatusDependencies
  extends
    Pick<ProjectDependencies, "projectStatus">,
    HostDependencies,
    Pick<ObservabilityDependencies, "workerVitals" | "monitor">,
    Pick<WorkerDependencies, "workerStatus"> {}

export interface DeprecatedStatusAliasOutput {
  deprecated: true;
  message: string;
  replacement: {
    tool: "status";
    args: { scope: StatusScope };
  };
  result: unknown;
}

const replacementSchema = z.object({
  tool: z.literal("status"),
  args: z.object({ scope: z.enum(["worker", "project", "host"]) }),
});

function aliasSchema(result: z.ZodTypeAny): z.ZodTypeAny {
  return z.object({
    deprecated: z.literal(true),
    message: z.string().min(1),
    replacement: replacementSchema,
    result,
  });
}

/** Preserve each absorbed tool's output validation around its alias envelope. */
export function deprecatedStatusAliasContract(
  source: CastleMcpOutputContract,
): CastleMcpOutputContract {
  return {
    version: source.version,
    schema: aliasSchema(source.schema),
    ...(source.projection === undefined
      ? {}
      : {
          projection: {
            input: source.projection.input,
            schema: aliasSchema(source.projection.schema),
          },
        }),
  };
}

const workerStatusOutputSchema = z.object({
  status: z.unknown(),
  vitals: workerVitalsOutputSchema,
  monitor: monitorOutputSchema,
});

const projectedWorkerStatusOutputSchema = z.object({
  status: z.unknown(),
  vitals: workerVitalsProjectedOutputSchema,
  monitor: monitorOutputSchema,
});

const hostStatusOutputSchema = z.object({
  state: z.unknown(),
  dashboard: z.unknown(),
  provision_check: z.unknown(),
  unit_status: z.unknown(),
});

export const statusContract: CastleMcpOutputContract = {
  version: CASTLE_MCP_CONTRACT_VERSION,
  schema: z.union([
    projectStatusOutputSchema,
    workerStatusOutputSchema,
    hostStatusOutputSchema,
  ]),
  projection: {
    input: "fields",
    schema: z.union([
      projectStatusOutputSchema,
      projectedWorkerStatusOutputSchema,
      hostStatusOutputSchema,
    ]),
  },
};

/** Keep an absorbed verb useful during its one-release alias window. */
export function deprecatedStatusAlias(
  alias: string,
  scope: StatusScope,
  result: unknown,
): DeprecatedStatusAliasOutput {
  return {
    deprecated: true,
    message: `${alias} is deprecated; use status { scope: ${scope} }`,
    replacement: { tool: "status", args: { scope } },
    result,
  };
}

async function readStatus(
  deps: StatusDependencies,
  input: StatusInput,
): Promise<unknown> {
  if (input.scope === "project") return deps.projectStatus();

  if (input.scope === "host") {
    const [state, dashboard, provision_check, unit_status] = await Promise.all([
      deps.hostState(),
      deps.hostDashboard(),
      deps.hostProvisionCheck(),
      deps.hostUnitStatus(),
    ]);
    return { state, dashboard, provision_check, unit_status };
  }

  const workerInput = {
    worker: input.worker,
    live_only: input.live_only ?? true,
    fields: input.fields,
  };
  const [status, vitals, monitor] = await Promise.all([
    deps.workerStatus(workerInput),
    deps.workerVitals({
      live_only: workerInput.live_only,
      fields: workerInput.fields,
    }),
    deps.monitor(),
  ]);
  return { status, vitals, monitor };
}

export function createStatusTools(deps: StatusDependencies): CastleMcpTool[] {
  return [
    {
      name: "status",
      title: "Read Castle status",
      description:
        "Answer the current worker, project, or host status through one intent-scoped read.",
      inputSchema: {
        scope: z.enum(["worker", "project", "host"]),
        worker: z.string().min(1).optional(),
        live_only: z.boolean().default(true),
        fields: z.array(z.string().min(1)).optional(),
      },
      outputContract: statusContract,
      invoke: (input) => readStatus(deps, input as unknown as StatusInput),
    },
  ];
}
