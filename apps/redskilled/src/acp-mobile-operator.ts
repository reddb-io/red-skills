// acp-mobile-operator — the local capability surface redskilled-link may project.
//
// The public ACP socket is local-user protected, but the operations here still
// require explicit host administration so adding a daemon method never widens
// the remote app by accident. redskilled-link owns the remote device allowlist;
// this module owns the smaller daemon allowlist behind it (ADR 0166).
import {
  MOBILE_OPERATOR_SCHEMA,
  REDSKILLS_ACP_METHODS,
  mobileOperatorStateParams,
  mobileTicketDispatchParams,
  mobileWorkerStopParams,
  type MobileOperatorStateAnswer,
  type MobileTicketDispatchAnswer,
  type MobileTicketDispatchParams,
  type MobileWorkerStopAnswer,
  type MobileWorkerStopParams,
} from "@reddb-io/protocol-acp";
import { RequestError } from "@agentclientprotocol/sdk";

import {
  redskillsAcpMethod,
  type RedskillsAcpMethodDomain,
} from "./acp-method-registry.js";
import type { RedskilledHostState } from "./host-state.js";

export interface AcpMobileOperatorDeps {
  readonly hostAdministration: boolean;
  readonly hostState: () => RedskilledHostState;
  readonly dispatch: (params: MobileTicketDispatchParams) => Promise<MobileTicketDispatchAnswer>;
  readonly stop: (params: MobileWorkerStopParams) => Promise<MobileWorkerStopAnswer>;
}

export function mobileOperatorMethodDomain(deps: AcpMobileOperatorDeps): RedskillsAcpMethodDomain {
  const requireAuthority = (): void => {
    if (!deps.hostAdministration) {
      throw RequestError.invalidRequest("this ACP endpoint has no Mobile operator authority");
    }
  };
  return {
    domain: "operator",
    bindings: [
      redskillsAcpMethod(
        REDSKILLS_ACP_METHODS.operatorState,
        mobileOperatorStateParams,
        () => {
          requireAuthority();
          return projectOperatorState(deps.hostState());
        },
      ),
      redskillsAcpMethod(
        REDSKILLS_ACP_METHODS.ticketDispatch,
        mobileTicketDispatchParams,
        async ({ params }) => {
          requireAuthority();
          return await deps.dispatch(params);
        },
      ),
      redskillsAcpMethod(
        REDSKILLS_ACP_METHODS.workerStop,
        mobileWorkerStopParams,
        async ({ params }) => {
          requireAuthority();
          return await deps.stop(params);
        },
      ),
    ],
    capability: deps.hostAdministration
      ? {
        mobileOperator: {
          version: MOBILE_OPERATOR_SCHEMA.version,
          methods: [...MOBILE_OPERATOR_SCHEMA.methods],
        },
      }
      : undefined,
  };
}

export function projectOperatorState(state: RedskilledHostState): MobileOperatorStateAnswer {
  return {
    version: 1,
    daemon_version: state.daemon_version,
    workers: state.workers.map((worker) => ({
      worker_id: worker.worker_id,
      project_label: worker.project_label,
      started_at: worker.started_at,
    })),
  };
}
