/**
 * daemon-termination — imperative process mechanics behind the stop report.
 *
 * A responsive daemon owns its graceful stop report. A live holder that cannot
 * answer has no remaining command surface, so the client sends SIGTERM itself
 * and verifies the same socket, lease, and process boundary as a normal stop.
 */
import { isPidAlive } from "@reddb-io/shared/resident-core.js";
import { socketAnswers } from "./daemon.js";
import { buildRedskilledUnreachableStop, type RedskilledDaemonStopped } from "./daemon-stop.js";
import type { RedskilledPaths } from "./paths.js";
import { readRedskilledLeaseFile } from "./session-lease.js";

export async function stopUnreachableRedskilledHolder(
  paths: RedskilledPaths,
  pid: number,
  timeoutMs: number,
): Promise<RedskilledDaemonStopped> {
  let signalFailure: string | undefined;
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    signalFailure = `SIGTERM could not be sent: ${error instanceof Error ? error.message : String(error)}`;
  }
  const settled = await waitForRedskilledShutdown(paths, pid, timeoutMs);
  return buildRedskilledUnreachableStop({
    socketPath: paths.socketPath,
    pid,
    stopped: settled.complete,
    pending: signalFailure == null ? settled.pending : [signalFailure, ...settled.pending],
  });
}

/** Wait for every daemon-owned anchor to be gone, not merely a quiet socket. */
export async function waitForRedskilledShutdown(
  paths: RedskilledPaths,
  pid: number | null,
  timeoutMs: number,
): Promise<{ readonly complete: boolean; readonly deadline: string; readonly pending: readonly string[] }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pending: string[] = [];
    if (await socketAnswers(paths.socketPath)) pending.push(`the socket ${JSON.stringify(paths.socketPath)} still answers`);
    if (await readRedskilledLeaseFile(paths.leasePath).catch(() => undefined)) {
      pending.push("the session lease is still held");
    }
    // In-process callers use their own pid for a test daemon; that process cannot
    // exit underneath the caller. The released lease and socket are the complete
    // lifecycle boundary there. A CLI caller always observes another process.
    if (pid != null && pid !== process.pid && isPidAlive(pid)) pending.push(`daemon pid ${pid} is still alive`);
    if (pending.length === 0) {
      return { complete: true, deadline: new Date(deadline).toISOString(), pending };
    }
    if (Date.now() >= deadline) {
      return { complete: false, deadline: new Date(deadline).toISOString(), pending };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
