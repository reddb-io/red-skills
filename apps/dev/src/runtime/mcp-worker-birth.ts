// mcp-worker-birth — how the MCP dispatch surface gets a Worker (#2976, ADR 0130).
//
// `worker_dispatch` was the birth path the cutover never crossed. The runtime's
// own spawn was deleted and its module declared, and the adapter went on
// starting Workers itself — one `spawn` behind an operator-facing tool, so three
// Workers ran while `host-state` said `workers: 0`, nothing on the event lane
// and nothing against the budget. **The tool an operator reaches for was the one
// path the ratchet never watched**, because a ratchet only covers the sites it
// is told about, and this one was never declared.
//
// So the dispatch asks the same daemon the rest of the project asks, through the
// same port, and **refuses when it cannot** (ADR 0130 rule 6). A dispatch that
// fell back to a local spawn would be exactly the Worker this module exists to
// stop: outside the host budget, absent from the host event lane, reported by no
// surface — and it would be invisible, because it would still say `dispatched`.
//
// The module holds no work knowledge: which ticket the Worker claims and which
// runner serves it are already in the argv the caller states, and neither the
// bundle nor the spawn is decided here. What it owns is the one translation the
// dispatch needs — an engine argv becomes a host worker spec.

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { logsDir } from "@reddb-io/shared/red-paths.js";
import type { RedskilledClientConfig } from "@reddb-io/redskilled/client";
import type { RedskilledPaths } from "@reddb-io/redskilled/paths";
import { publishedBundleArgv } from "./published-entry.js";
import {
  createRedskilledBirthPort,
  redskilledUnreachableAdvice,
} from "./redskilled-birth.js";

/** Where a dispatched Worker's stdout/stderr is persisted, in the disposable
 * logs lane (ADR 0098). A Worker that dies before it writes its own state used
 * to leave nothing but `worker.pid` — three silent deaths in a row with zero
 * evidence anywhere (#2385, #2376). The dispatch keeps the bytes; since #2976
 * the daemon is the one that opens the file, because the daemon owns the
 * process whose descriptors those are. */
export function dispatchLogPath(root: string, stampIso: string): string {
  const safe = stampIso.replace(/[:.]/g, "-");
  return join(logsDir(root, stampIso.slice(0, 10)), `dispatch-${safe}.log`);
}

/** A Worker the host granted to a dispatch, in the facts the caller reports. */
export interface DispatchedWorkerBirth {
  readonly worker_id: string;
  readonly pid: number;
  /** Post-mortem handle: where the host pointed this Worker's output. */
  readonly log: string;
  /** Warnings the host attached — a downgraded unit is running AND degraded. */
  readonly warnings: readonly string[];
  /** The host's own sentence about the ceiling that admitted this birth. */
  readonly admission: string;
}

/** Everything a test poses as; a real dispatch passes none of it. */
export interface WorkerBirthOptions {
  readonly paths?: RedskilledPaths;
  readonly config?: RedskilledClientConfig;
  readonly projectLabel?: string;
  /** The published bundle argv head — resolved from the published entry by default. */
  readonly entry?: readonly string[];
  /** The stamp naming the log file; defaults to now plus a short uniquifier. */
  readonly stamp?: string;
}

/**
 * Ask the host for one dispatched Worker, or refuse and start nothing.
 *
 * `args` is the engine argv AFTER `run` — the same list the dispatch used to
 * hand its own spawn — so the caller states the work and this states the host
 * spec. The bundle comes from the PUBLISHED entry rather than from this
 * process's own, for the reason #2808 names: a Worker born from the caller's
 * bundle inherits whatever skew that caller is carrying.
 */
export async function requestWorkerBirth(
  root: string,
  args: readonly string[],
  options: WorkerBirthOptions = {},
): Promise<DispatchedWorkerBirth> {
  const port = createRedskilledBirthPort({
    root,
    ...(options.projectLabel !== undefined ? { projectLabel: options.projectLabel } : {}),
    ...(options.paths !== undefined ? { paths: options.paths } : {}),
    ...(options.config !== undefined ? { config: options.config } : {}),
  });
  const [command, ...head] = options.entry ?? publishedBundleArgv();
  if (command === undefined) {
    throw new Error("cannot dispatch worker: the published bundle resolved to an empty argv");
  }
  const stamp = options.stamp ?? `${new Date().toISOString()}-${randomUUID().slice(0, 8)}`;
  const log = dispatchLogPath(root, stamp);

  let granted;
  try {
    await port.reach();
    granted = await port.start({
      // The port states the project label itself; a caller that could name it
      // would be a caller that could file another project's Worker (rule 11).
      project_label: "",
      workspace_path: root,
      log_path: log,
      command,
      args: [...head, "run", ...args],
    });
  } catch (err) {
    // Named, and it starts nothing: an operator reading this needs to know that
    // no Worker exists, and which of "start the daemon" / "fix the client that
    // stopped asking it" is their repair.
    throw new Error(redskilledUnreachableAdvice(port.socketPath, err));
  }

  return {
    worker_id: granted.workerId,
    pid: granted.pid,
    log,
    warnings: granted.warnings,
    admission: granted.admission,
  };
}
