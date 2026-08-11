/** A bounded, probe-only statusline payload read for prompt renderers. */
import { randomUUID } from "node:crypto";
import {
  RedskilledRequestRefusedError,
  RedskilledUnreachableError,
  type RedskilledClientConfig,
} from "./client.js";
import { resolveRedskilledClientEndpoint } from "./client-rendezvous.js";
import type { RedskilledPaths } from "./paths.js";
import {
  isRedskilledStatuslinePayload,
  sendRedskilledRequest,
  type RedskilledStatuslinePayload,
} from "./protocol.js";
import type { RedskilledStatuslineExtrasRequest } from "./statusline-payload.js";

/**
 * Probe the statusline payload from an already-running daemon.
 *
 * Unlike the ordinary client read, this path NEVER calls
 * `ensureRedskilledDaemon`: a prompt renderer may observe the daemon, but it may
 * not birth one. The caller owns the short request deadline appropriate to its
 * surface (the Dev statusline uses 150ms).
 */
export async function probeRedskilledStatuslinePayload(
  paths: RedskilledPaths,
  config: RedskilledClientConfig = {},
  extras?: RedskilledStatuslineExtrasRequest,
): Promise<RedskilledStatuslinePayload> {
  const endpoint = (await resolveRedskilledClientEndpoint(paths)).paths;
  let response;
  try {
    response = await sendRedskilledRequest(
      { socketPath: endpoint.socketPath, timeoutMs: config.requestTimeoutMs ?? 2_000 },
      {
        id: randomUUID(),
        op: "statusline-payload",
        ...(config.sessionProject != null ? { session_project: config.sessionProject } : {}),
        ...(extras == null ? {} : { extras }),
      },
    );
  } catch (err) {
    // Do not run a second presence probe here. This read owns one socket attempt
    // and one deadline; another diagnostic reach could freeze the prompt after
    // the operation it was diagnosing had already timed out.
    throw new RedskilledUnreachableError(endpoint.socketPath, err);
  }
  if (!response.ok) throw new RedskilledRequestRefusedError(response.error);
  if (!isRedskilledStatuslinePayload(response.value)) {
    throw new Error("redskilled daemon returned a malformed statusline payload");
  }
  return response.value;
}
