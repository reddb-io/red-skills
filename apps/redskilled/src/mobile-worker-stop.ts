import type { MobileWorkerStopAnswer, MobileWorkerStopParams } from "@reddb-io/protocol-acp";
import type { RedskilledWorkerCommandRequest, RedskilledWorkerCommandResult } from "./protocol.js";

/** Project the Mobile stop verb onto the daemon's one Worker death mechanism. */
export function createMobileWorkerStop(
  command: (request: RedskilledWorkerCommandRequest) => Promise<RedskilledWorkerCommandResult>,
): (params: MobileWorkerStopParams) => Promise<MobileWorkerStopAnswer> {
  return async ({ worker_id }) => {
    const result = await command({
      worker_id,
      command: "stop",
      detail: "stopped by a paired Mobile operator",
    });
    return {
      version: 1,
      worker_id,
      applied: result.applied,
      detail: result.detail,
    };
  };
}
