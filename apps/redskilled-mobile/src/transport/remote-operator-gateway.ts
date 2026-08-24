import { createRedskilledMobileLinkClient } from "@reddb-io/red-skills-link-protocol/mobile-client";
import type {
  RedskilledLinkOperationAnswer,
  RedskilledLinkPairedHost,
} from "@reddb-io/red-skills-link-protocol/protocol";

import type {
  MobileHostSnapshot,
  MobileOperatorGateway,
  TicketDispatchReceipt,
  TicketDispatchRequest,
} from "../domain/ticket-dispatch";

/**
 * Map one state answer onto the app's snapshot. PURE, exported for its test.
 *
 * The v2 extras are read when present and rendered as absent when not — a Host
 * still serving the v1 shape yields rows with `null` extras and a `null`
 * staleness block, never a thrown-away frame: the app's honesty about THAT
 * host is "it told us nothing", not "it is broken".
 */
export function snapshotFromStateAnswer(
  answer: RedskilledLinkOperationAnswer,
): MobileHostSnapshot {
  if (!("workers" in answer) || !Array.isArray(answer.workers)) {
    throw new Error("Host returned an invalid Worker state");
  }
  const host = "host" in answer ? answer.host : null;
  return {
    workers: answer.workers.map((worker) => ({
      workerId: worker.worker_id,
      repository: worker.repository ?? worker.project_label,
      ticket: worker.ticket ?? undefined,
      startedAt: worker.started_at,
      phase: worker.phase ?? null,
      heartbeatAgeMs: worker.heartbeat_age_ms ?? null,
    })),
    daemonVersion: host?.daemon_version ?? answer.daemon_version ?? null,
    generatedAt: host?.generated_at ?? null,
    staleness: host?.staleness == null
      ? null
      : {
        stale: host.staleness.stale,
        ageMs: host.staleness.age_ms,
        reason: host.staleness.reason,
      },
  };
}

export function createRemoteOperatorGateway(
  host: RedskilledLinkPairedHost,
): MobileOperatorGateway {
  const client = createRedskilledMobileLinkClient(host);
  return {
    async dispatch(request: TicketDispatchRequest): Promise<TicketDispatchReceipt> {
      if (request.hostId !== host.host_id) throw new Error("Dispatch targeted another paired Host");
      const answer = await client.dispatch(request.issueUrl);
      if (!("worker_id" in answer) || !("repository" in answer) || !("ticket" in answer)) {
        throw new Error("Host returned an invalid Ticket dispatch receipt");
      }
      return {
        version: 1,
        hostId: host.host_id,
        repository: answer.repository,
        ticket: answer.ticket,
        workerId: answer.worker_id,
      };
    },
    async state() {
      return snapshotFromStateAnswer(await client.state());
    },
    async stop(workerId) {
      const answer = await client.stop(workerId);
      if (!("applied" in answer) || answer.worker_id !== workerId) {
        throw new Error("Host returned an invalid Worker stop receipt");
      }
      return answer.applied;
    },
  };
}
