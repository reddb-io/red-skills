import { parseGitHubIssueUrl } from "../domain/issue-url";
import type {
  TicketDispatchGateway,
  TicketDispatchReceipt,
  TicketDispatchRequest,
} from "../domain/ticket-dispatch";

export function createPreviewDispatchGateway(
  isDevelopment = __DEV__,
): TicketDispatchGateway {
  return {
    async dispatch(
      request: TicketDispatchRequest,
    ): Promise<TicketDispatchReceipt> {
      if (!isDevelopment) {
        throw new Error("Remote link ainda não está configurado");
      }

      const issue = parseGitHubIssueUrl(request.issueUrl);
      await new Promise((resolve) => setTimeout(resolve, 450));

      return {
        version: 1,
        hostId: request.hostId,
        repository: `${issue.owner}/${issue.repository}`,
        ticket: issue.ticket,
        workerId: `preview:W${issue.ticket}`,
        sessionId: `preview-session-${issue.ticket}`,
      };
    },
  };
}
