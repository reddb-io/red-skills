// The canary harness's worker role — what a slot becomes when its entry can
// actually route `run`.
//
// It reproduces the ONE thing the canary reads as drainage: a worker directory
// under the workers lane holding a live `worker.pid` (ADR 0128 §5). It runs no
// agent and touches no queue, because the lane's plumbing — not the drain — is
// what went silently inert in #2677.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { workerDir, workerPidFile } from "../../../src/core/worker-paths.js";
import { afkPaths } from "../../../src/runtime/wire.js";

const POLL_MS = 100;

/** Worker ids are `w` + 4 chars; derive one from the pid so it is unique per
 * slot process and needs no randomness. */
function workerId(pid: number): string {
  return `wC${String(pid).slice(-3).padStart(3, "0")}`;
}

export async function canaryWorker(): Promise<number> {
  const root = process.cwd();
  const paths = afkPaths(root, process.env.RED_AFK_FLEET);
  const worker = workerId(process.pid);
  mkdirSync(workerDir(paths.tmpDir, worker), { recursive: true });
  const pidFile = workerPidFile(paths.tmpDir, worker);
  writeFileSync(pidFile, String(process.pid), "utf8");

  const retireFile = process.env.RED_AFK_RETIRE_FILE;
  return new Promise<number>((resolve) => {
    const finish = (code: number): void => {
      clearInterval(timer);
      rmSync(pidFile, { force: true });
      resolve(code);
    };
    const timer = setInterval(() => {
      // A real worker exits when its fleet retires it. Both signals are honoured
      // so a forced `fleet_stop` (supervisor pid file removed) and a graceful
      // slot retire leave no live worker behind.
      if (!existsSync(paths.supervisorPidPath)) finish(0);
      else if (retireFile !== undefined && retireFile !== "" && existsSync(retireFile)) finish(0);
    }, POLL_MS);
    process.once("SIGTERM", () => finish(143));
    process.once("SIGINT", () => finish(130));
  });
}
