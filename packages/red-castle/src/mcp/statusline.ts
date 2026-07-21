import type { CastleMcpTool } from "./tool.js";

export interface StatuslineDependencies {
  statuslineAggregate(): Promise<unknown>;
}

export function createStatuslineTools(deps: StatuslineDependencies): CastleMcpTool[] {
  return [
    {
      name: "statusline_aggregate",
      title: "Read statusline aggregate",
      description:
        "Return the castle-side statusline aggregate (project, repo counters, fleet, workers, queue) as structured data, using the same collector cores and cache discipline as the command-backed statusLine. Host-side fields (session model/effort, context %, usage quotas) are out of scope.",
      inputSchema: {},
      invoke: () => deps.statuslineAggregate(),
    },
  ];
}
