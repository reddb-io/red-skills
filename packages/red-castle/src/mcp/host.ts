// host.ts — read-only visibility into the machine-wide redskilled daemon.
//
// A project tool answers only for the checkout that called it. These tools
// deliberately cross that read boundary so an operator can diagnose the host
// that owns every project's Workers, while exposing none of the daemon's
// mutating `provision` or `reclaim` commands (ADR 0130, issue #3163).

import type { CastleMcpTool } from "./tool.js";
import { deprecatedStatusAlias } from "./status.js";

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
      title: "Deprecated host state alias",
      description:
        "DEPRECATED: use status { scope: host }. Returns daemon host state and names its replacement.",
      inputSchema: {},
      invoke: async () =>
        deprecatedStatusAlias("host_state", "host", await deps.hostState()),
    },
    {
      name: "host_dashboard",
      title: "Deprecated host dashboard alias",
      description:
        "DEPRECATED: use status { scope: host }. Returns the global dashboard and names its replacement.",
      inputSchema: {},
      invoke: async () =>
        deprecatedStatusAlias(
          "host_dashboard",
          "host",
          await deps.hostDashboard(),
        ),
    },
    {
      name: "host_provision_check",
      title: "Deprecated host provisioning alias",
      description:
        "DEPRECATED: use status { scope: host }. Returns the provisioning check and names its replacement.",
      inputSchema: {},
      invoke: async () =>
        deprecatedStatusAlias(
          "host_provision_check",
          "host",
          await deps.hostProvisionCheck(),
        ),
    },
    {
      name: "host_unit_status",
      title: "Deprecated host unit status alias",
      description:
        "DEPRECATED: use status { scope: host }. Returns the unit status and names its replacement.",
      inputSchema: {},
      invoke: async () =>
        deprecatedStatusAlias(
          "host_unit_status",
          "host",
          await deps.hostUnitStatus(),
        ),
    },
  ];
}
