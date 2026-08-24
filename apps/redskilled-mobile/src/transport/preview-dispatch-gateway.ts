import { parseGitHubIssueUrl } from "../domain/issue-url";
import type {
  MobileHostSnapshot,
  MobileOperatorGateway,
  TicketDispatchReceipt,
  TicketDispatchRequest,
} from "../domain/ticket-dispatch";

export function createPreviewDispatchGateway(
  isDevelopment = __DEV__,
): MobileOperatorGateway {
  const refuse = (): never => {
    throw new Error("Remote link is not configured yet");
  };
  const dispatched: Array<{ workerId: string; repository: string; ticket: number; startedAt: string }> = [];
  return {
    async dispatch(
      request: TicketDispatchRequest,
    ): Promise<TicketDispatchReceipt> {
      if (!isDevelopment) refuse();

      const issue = parseGitHubIssueUrl(request.issueUrl);
      await new Promise((resolve) => setTimeout(resolve, 450));

      const receipt = {
        version: 1 as const,
        hostId: request.hostId,
        repository: `${issue.owner}/${issue.repository}`,
        ticket: issue.ticket,
        workerId: `preview:W${issue.ticket}`,
        sessionId: `preview-session-${issue.ticket}`,
      };
      dispatched.unshift({
        workerId: receipt.workerId,
        repository: receipt.repository,
        ticket: receipt.ticket,
        startedAt: new Date().toISOString(),
      });
      return receipt;
    },
    // The preview serves the same v2-shaped snapshot the remote gateway maps,
    // so the app's honest-status path is exercised in development instead of
    // being replaced by a second, simpler fiction.
    async state(): Promise<MobileHostSnapshot> {
      if (!isDevelopment) refuse();
      return {
        workers: dispatched.map((worker) => ({
          ...worker,
          phase: "coding",
          heartbeatAgeMs: 3_000,
        })),
        daemonVersion: "preview",
        generatedAt: new Date().toISOString(),
        staleness: { stale: false, ageMs: 3_000, reason: "preview snapshot" },
      };
    },
    async stop(workerId: string): Promise<boolean> {
      if (!isDevelopment) refuse();
      const index = dispatched.findIndex((worker) => worker.workerId === workerId);
      if (index >= 0) dispatched.splice(index, 1);
      return index >= 0;
    },
  };
}
