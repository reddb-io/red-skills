// ping-answer — the one answer that must survive everything else being broken.
//
// A ping is asked precisely when a caller cannot tell whether the daemon is
// alive, so its answer is assembled from three values the process already holds
// — never from a registration, a store, a socket read, or a worker map. Keeping
// it a pure function of those three makes that property checkable instead of
// merely intended, and keeps the lifecycle module free of an answer that has no
// lifecycle.
import { REDSKILLED_PROTOCOL_VERSION, type RedskilledResponse } from "../protocol.js";

/** Build the ping response for one request id. */
export function pingAnswer(id: string, daemonVersion: string, pid: number): RedskilledResponse {
  return {
    id,
    ok: true,
    value: { pong: true, protocol_version: REDSKILLED_PROTOCOL_VERSION, daemon_version: daemonVersion, pid },
  };
}
