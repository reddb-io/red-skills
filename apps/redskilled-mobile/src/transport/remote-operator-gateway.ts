import { createRedskilledMobileLinkClient } from "@reddb-io/red-skills-link-protocol/mobile-client";
import type { RedskilledLinkPairedHost } from "@reddb-io/red-skills-link-protocol/protocol";

import type {
  MobileOperatorGateway,
  TicketDispatchReceipt,
  TicketDispatchRequest,
} from "../domain/ticket-dispatch";

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
      const answer = await client.state();
      if (!("workers" in answer) || !Array.isArray(answer.workers)) {
        throw new Error("Host returned an invalid Worker state");
      }
      return answer.workers.map((worker) => ({
        workerId: worker.worker_id,
        repository: worker.project_label,
        startedAt: worker.started_at,
      }));
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
