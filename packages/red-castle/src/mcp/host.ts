// host.ts — read-only visibility into the machine-wide redskilled daemon.
//
// A project tool answers only for the checkout that called it. These tools
// deliberately cross that read boundary so an operator can diagnose the host
// that owns every project's Workers, while exposing none of the daemon's
// mutating `provision` or `reclaim` commands (ADR 0130, issue #3163).

import type { CastleMcpTool } from "./tool.js";

export interface HostDependencies {
  hostState(): Promise<unknown>;
  hostDashboard(): Promise<unknown>;
  hostProvisionCheck(): Promise<unknown>;
  hostUnitStatus(): Promise<unknown>;
}

export function createHostTools(deps: HostDependencies): CastleMcpTool[] {
  return [
    {
      name: "host_state",
      title: "Read daemon host state",
      description:
        "Return every project and Worker the redskilled daemon holds on this machine.",
      inputSchema: {},
      invoke: async () => deps.hostState(),
    },
    {
      name: "host_dashboard",
      title: "Read daemon host dashboard",
      description:
        "Return the structured global dashboard for every project's Workers on this machine.",
      inputSchema: {},
      invoke: async () => deps.hostDashboard(),
    },
    {
      name: "host_provision_check",
      title: "Check daemon host provisioning",
      description:
        "Read whether this machine is ready to run redskilled and what is missing; creates and starts nothing.",
      inputSchema: {},
      invoke: async () => deps.hostProvisionCheck(),
    },
    {
      name: "host_unit_status",
      title: "Read daemon unit status",
      description:
        "Return whether the optional redskilled supervisor unit is installed, enabled, and active.",
      inputSchema: {},
      invoke: async () => deps.hostUnitStatus(),
    },
  ];
}
