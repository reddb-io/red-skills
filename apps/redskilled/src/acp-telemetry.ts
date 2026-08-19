// acp-telemetry — the `telemetry` `_redskills/*` domain: the metrics method.
//
// The counters are HOST-wide — a birth in one project and a birth in another are
// the same series under different labels — so the method is answerable only from
// an endpoint explicitly started with host-administrative authority, exactly as
// `host_budgets` is. An ordinary project connection reading them would learn the
// labels, and therefore the existence, of every other project on the machine.
//
// It is advertised only where it is answerable, for the reason the budget domain
// states: a connection told about a capability and then refused for lacking
// authority learned nothing it could act on.
import { RequestError } from "@agentclientprotocol/sdk";
import { REDSKILLS_ACP_METHODS, emptyRedskillsParams } from "@reddb-io/protocol-acp";

import {
  redskillsAcpMethod,
  type RedskillsAcpMethodDomain,
} from "./acp-method-registry.js";
import {
  redskilledMetricsSnapshot,
  type RedskilledMetricsSnapshot,
} from "./telemetry-metrics.js";

export const REDSKILLED_METRICS_METHOD = REDSKILLS_ACP_METHODS.metrics;

/** The counters this domain answers from, and who may read them. */
export interface AcpTelemetryDeps {
  /** Explicit endpoint authority; ordinary project ACP stays false. */
  readonly hostAdministration: boolean;
  /** Test seam; production reads the daemon process's own registry. */
  readonly snapshot?: () => RedskilledMetricsSnapshot;
}

/** The metrics method names no project, no window and no series; it reads the host. */
export const emptyMetricsParams: (value: unknown) => Record<string, never> = emptyRedskillsParams(
  "metrics requests accept no caller-controlled scope, window or series selector",
);

export function telemetryMethodDomain(deps: AcpTelemetryDeps): RedskillsAcpMethodDomain {
  const read = deps.snapshot ?? redskilledMetricsSnapshot;
  return {
    domain: "telemetry",
    bindings: [
      redskillsAcpMethod(REDSKILLS_ACP_METHODS.metrics, emptyMetricsParams, (): RedskilledMetricsSnapshot => {
        if (!deps.hostAdministration) {
          throw RequestError.invalidRequest(
            "this project-scoped ACP connection has no host-administrative authority",
          );
        }
        return read();
      }),
    ],
    ...(deps.hostAdministration
      ? { capability: { metrics: { version: 1, methods: [REDSKILLS_ACP_METHODS.metrics] } } }
      : {}),
  };
}
