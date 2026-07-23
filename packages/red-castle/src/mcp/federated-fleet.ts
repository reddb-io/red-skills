import type { CastleMcpTool } from "./tool.js";
import {
  federatedFleetViewContract,
  type FederatedFleetViewOutput,
} from "./contracts.js";

export interface FederatedFleetDependencies {
  federatedFleetView(): Promise<FederatedFleetViewOutput>;
}

export function createFederatedFleetTools(
  deps: FederatedFleetDependencies,
): CastleMcpTool[] {
  return [
    {
      name: "federated_fleet_view",
      title: "Federated fleet view",
      description:
        "Return the aggregated cross-host fleet view: per-host supervisor, slots, workers, queue posture, last-event age, and silent-host markers. Single-host mode returns exactly one host entry and is byte-stable with the local fleet view.",
      inputSchema: {},
      outputContract: federatedFleetViewContract,
      invoke: () => deps.federatedFleetView(),
    },
  ];
}
