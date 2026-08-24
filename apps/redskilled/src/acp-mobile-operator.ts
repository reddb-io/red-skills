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
import type { RedskilledStatuslinePayload } from "./statusline-payload.js";

export interface AcpMobileOperatorDeps {
  readonly hostAdministration: boolean;
  readonly hostState: () => RedskilledHostState;
  /**
   * The statusline document composed beside the answer, when the daemon has one.
   *
   * Optional so thin embeddings and tests run on host state alone; when absent
   * the v2 host block says so (`staleness: null`) instead of inventing a verdict.
   */
  readonly statuslinePayload?: () => RedskilledStatuslinePayload | null;
  readonly clock?: () => string;
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
          return projectOperatorState(deps.hostState(), {
            statusline: deps.statuslinePayload?.() ?? null,
            now: deps.clock?.() ?? new Date().toISOString(),
          });
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

export interface MobileOperatorStateSources {
  /** The one statusline read this answer dates itself and its Workers by. */
  readonly statusline?: RedskilledStatuslinePayload | null;
  /** The answer's own instant; falls back to the statusline's when absent. */
  readonly now?: string;
}

/**
 * Project the v2 app state: host facts plus what each project PUBLISHED.
 *
 * Everything per-Worker beyond the v1 identity comes from the statusline
 * document rather than a second read, so the phone and the terminal describe
 * the same instant — and a Worker the document does not cover renders its
 * extras as `null`, never as a guess. Paths, pids, credentials, vitals and log
 * lines deliberately never cross this wire (ADR 0166).
 */
export function projectOperatorState(
  state: RedskilledHostState,
  sources: MobileOperatorStateSources = {},
): MobileOperatorStateAnswer {
  const statusline = sources.statusline ?? null;
  const generatedAt = statusline?.generated_at ?? sources.now ?? state.started_at;
  const generatedMs = Date.parse(generatedAt);
  const published = new Map(
    (statusline?.workers ?? []).map((worker) => [worker.worker_id, worker]),
  );
  const repositories = new Map(
    (statusline?.repository_activity?.projects ?? []).map(
      (project) => [project.project_label, project.repository],
    ),
  );
  return {
    version: 2,
    daemon_version: state.daemon_version,
    workers: state.workers.map((worker) => {
      const row = published.get(worker.worker_id);
      const publishedAt = row?.log.published_at ?? null;
      const publishedMs = publishedAt == null ? Number.NaN : Date.parse(publishedAt);
      return {
        worker_id: worker.worker_id,
        project_label: worker.project_label,
        started_at: worker.started_at,
        phase: row?.display?.phase ?? null,
        heartbeat_age_ms:
          Number.isNaN(publishedMs) || Number.isNaN(generatedMs)
            ? null
            : Math.max(0, generatedMs - publishedMs),
        repository: repositories.get(worker.project_label) ?? null,
        ticket: row?.display?.issue ?? null,
      };
    }),
    host: {
      daemon_version: state.daemon_version,
      started_at: state.started_at,
      worker_ceiling: state.ceiling?.worker_count ?? null,
      staleness: statusline == null
        ? null
        : {
          stale: statusline.staleness.stale,
          age_ms: statusline.staleness.age_ms,
          threshold_ms: statusline.staleness.threshold_ms,
          reason: statusline.staleness.reason,
        },
      generated_at: generatedAt,
    },
  };
}
