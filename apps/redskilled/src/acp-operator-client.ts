/** Typed local ACP client used only by redskilled-link's Host role. */
import { connect, type Socket } from "node:net";
import { client, methods } from "@agentclientprotocol/sdk";
import {
  ACP_PROTOCOL_VERSION,
  REDSKILLS_ACP_METHODS,
  REDSKILLS_WIRE_MAJOR,
  socketStream,
  type MobileOperatorStateAnswer,
  type MobileTicketDispatchAnswer,
  type MobileWorkerStopAnswer,
} from "@reddb-io/protocol-acp";

import { ensureRedskilledDaemon } from "./client.js";
import { resolveRedskilledClientEndpoint } from "./client-rendezvous.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "./paths.js";

export interface RedskillsOperatorAcpClient {
  state(): Promise<MobileOperatorStateAnswer>;
  dispatch(issueUrl: string): Promise<MobileTicketDispatchAnswer>;
  stop(workerId: string): Promise<MobileWorkerStopAnswer>;
}

export interface RedskillsOperatorAcpClientOptions {
  /**
   * `false` = probe only: answer from the daemon that IS there, or fail —
   * never provision or start one. A status read that births the thing it
   * reports on cannot tell an idle machine from the machine it just changed.
   * Default `true`, the behavior every existing caller (dispatch, host) wants.
   */
  readonly ensure?: boolean;
}

export function createRedskillsOperatorAcpClient(
  paths: RedskilledPaths = resolveRedskilledPaths(),
  options: RedskillsOperatorAcpClientOptions = {},
): RedskillsOperatorAcpClient {
  const request = async <Answer>(method: string, params: object): Promise<Answer> => {
    if (options.ensure !== false) await ensureRedskilledDaemon(paths);
    const endpoint = (await resolveRedskilledClientEndpoint(paths)).paths;
    const socket = await connectEndpoint(endpoint.acpSocketPath);
    const connection = client({ name: "redskilled-link" }).connect(socketStream(socket));
    try {
      await connection.agent.request(methods.agent.initialize, {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "redskilled-link", version: "1" },
        _meta: { redskills: { wireMajor: REDSKILLS_WIRE_MAJOR } },
      });
      return await connection.agent.request<Answer>(method, params);
    } finally {
      connection.close();
      socket.destroy();
    }
  };
  return {
    state: () => request(REDSKILLS_ACP_METHODS.operatorState, {}),
    dispatch: (issueUrl) => request(REDSKILLS_ACP_METHODS.ticketDispatch, { issue_url: issueUrl }),
    stop: (workerId) => request(REDSKILLS_ACP_METHODS.workerStop, { worker_id: workerId }),
  };
}

async function connectEndpoint(path: string): Promise<Socket> {
  return await new Promise<Socket>((resolve, reject) => {
    const socket = connect(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}
