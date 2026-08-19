// acp-host-methods — the `host` `_redskills/*` domain.
//
// One method, and its name is a compatibility spelling: `host_state`
// answers a PROJECT projection, not the host's. Ordinary access to the public
// ACP socket is not an administrative capability, so what a connection reads is
// scoped to the Project that bound it — the host-wide facts live behind the
// budget domain's explicitly administrative endpoint.
import { REDSKILLS_ACP_METHODS } from "@reddb-io/protocol-acp";

import {
  acpNoParams,
  redskillsAcpMethod,
  type RedskillsAcpMethodDomain,
} from "./acp-method-registry.js";

export const REDSKILLED_HOST_STATE_METHOD = REDSKILLS_ACP_METHODS.hostState;

export interface AcpHostStateDeps {
  /** The Project projection this connection is allowed to read. */
  scopedState: () => unknown;
}

/** The host domain: the Project-scoped state projection, and nothing wider. */
export function hostStateMethodDomain(deps: AcpHostStateDeps): RedskillsAcpMethodDomain {
  return {
    domain: "host",
    bindings: [redskillsAcpMethod(REDSKILLED_HOST_STATE_METHOD, acpNoParams, () => deps.scopedState())],
  };
}
