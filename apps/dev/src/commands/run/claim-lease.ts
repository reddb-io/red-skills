import { join } from "node:path";
import { createFsIssueLeaseStore } from "@reddb-io/worker";
import { workerIdentity } from "../../core/host-identity.js";
import * as fsx from "../../runtime/fs.js";

/**
 * Local per-host issue lease — the ONE lease implementation, in castle (#2578).
 * Its leaf `<claims>/<issue>/` dir is the atomic POSIX mkdir lock (#434); a dead
 * holder is reclaimed through the #568 atomic-rename steal. `pidAlive` injects
 * this host's `kill -0` verdict (castle stays liveness-IO free); the owner token
 * is the ADR 0066 worker identity, so a release only removes the lease we
 * actually hold. The owner-token liveness is `unknown` here because the pid
 * signal alone arbitrates same-host steals on this path.
 */
export function makeClaimLock(
  tmpDir: string,
  workerId: string,
): {
  acquire: (issue: number) => Promise<boolean>;
  release: (issue: number) => Promise<void>;
} {
  const store = createFsIssueLeaseStore(join(tmpDir, "claims"), {
    pid: process.pid,
    pidAlive: (p) => (fsx.pidAlive(String(p)) ? "alive" : "dead"),
  });
  const owner = workerIdentity(workerId);
  return {
    acquire: async (issue) => (await store.acquire(issue, owner, () => "unknown")).acquired,
    release: (issue) => store.release(issue, owner),
  };
}
