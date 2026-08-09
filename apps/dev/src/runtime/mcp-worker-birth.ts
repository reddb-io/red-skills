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

import type { RedskilledClientConfig } from "@reddb-io/redskilled/client";
import type { RedskilledPaths } from "@reddb-io/redskilled/paths";
import { publishedBundleArgv } from "./published-entry.js";
import { getConfig, loadConfig } from "../core/config.js";
import { afkPaths } from "./wire/paths.js";
import {
  createRedskilledBirthPort,
  redskilledUnreachableAdvice,
  type RedskilledBirthPort,
} from "./redskilled-birth.js";
import { workerLogPathTemplate } from "./redskilled-worker-log.js";

/** A Worker the host granted to a dispatch, in the facts the caller reports. */
export interface DispatchedWorkerBirth {
  readonly worker_id: string;
  readonly pid: number;
  readonly fork_sha: string;
  /**
   * Post-mortem handle: the log the host actually opened, or null when none.
   *
   * The dispatch DECLARES `.red/tmp/workers/{{worker_id}}/worker.log.toonl` and
   * the host resolves it, so this is the one fact only the host can state — and
   * a null is a Worker the operator must follow on its heartbeat instead of a
   * filename pointing at a file nobody created (#3440).
   */
  readonly log: string | null;
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
  /** Host capacity claimed by `/go` and `/go --scout`; ordinary AFK omits it. */
  readonly reservation?: "interactive";
  /** The host boundary; injected only when replaying a dispatch in tests. */
  readonly port?: WorkerBirthPort;
}

/** The narrow host boundary a detached dispatch crosses. */
export interface WorkerBirthPort {
  readonly socketPath: string;
  readonly reach: RedskilledBirthPort["reach"];
  readonly start: RedskilledBirthPort["start"];
  readonly drainEvents: () => Promise<readonly WorkerBirthEvent[]>;
}

/** The only event facts a dispatcher needs to attribute a failed birth. */
export type WorkerBirthEvent = Pick<
  Awaited<ReturnType<RedskilledBirthPort["drainEvents"]>>[number],
  "kind" | "worker_id" | "detail"
>;

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
  const port = options.port ?? createRedskilledBirthPort({
    root,
    ...(options.projectLabel !== undefined ? { projectLabel: options.projectLabel } : {}),
    ...(options.paths !== undefined ? { paths: options.paths } : {}),
    ...(options.config !== undefined ? { config: options.config } : {}),
  });
  const [command, ...head] = options.entry ?? publishedBundleArgv();
  if (command === undefined) {
    throw new Error("cannot dispatch worker: the published bundle resolved to an empty argv");
  }
  // The SAME lane every Worker writes to, stated with the same placeholder the
  // registration lane uses (#3440). The dispatcher cannot name `workers/<id>/`
  // because the host mints the id — which is why this used to stamp a dated
  // plain-text file of its own — but the daemon has substituted `{{worker_id}}`
  // at birth since Amendment 5, so the chicken-and-egg the detour existed for
  // was already solved. `/go` stays distinguishable by `origin=go` and
  // `current.kind=go` on the worker state: provenance is a stamp, never a
  // directory name.
  const log = workerLogPathTemplate(root);
  const config = loadConfig(afkPaths(root).configPath, { warn: () => undefined });
  const trunk = getConfig(config, "dev.trunk") || "main";

  let granted;
  let freshEventWindow = false;
  try {
    await port.reach();
    // Establish the cursor before asking for a Worker. Only events after this
    // read can describe this dispatch; an old boot refusal must never overwrite
    // a current transport failure with a more convenient story.
    await port.drainEvents();
    freshEventWindow = true;
    granted = await port.start({
      // The port states the project label itself; a caller that could name it
      // would be a caller that could file another project's Worker (rule 11).
      project_label: "",
      workspace_path: root,
      trunk: { remote: "origin", branch: trunk },
      log_path: log,
      command,
      args: [...head, "run", ...args],
      ...(options.reservation == null ? {} : { reservation: options.reservation }),
    });
  } catch (err) {
    const events = freshEventWindow
      ? await port.drainEvents().catch(() => [])
      : [];
    const refusal = bootRefusalAfterGrant(events);
    if (refusal != null) {
      throw new Error(
        `Worker ${refusal.workerId} was granted and then refused at boot. ` +
          `Daemon evidence: ${refusal.evidence}`,
      );
    }
    // No fresh host evidence contradicted the transport failure. Keep the
    // existing unreachability detail and its cause-specific repair unchanged.
    throw new Error(redskilledUnreachableAdvice(port.socketPath, err));
  }

  return {
    worker_id: granted.workerId,
    pid: granted.pid,
    fork_sha: granted.forkSha,
    // The host's answer, not the declaration: `log` above still holds
    // `{{worker_id}}`, and reporting a template as a path is how an operator
    // comes to `cat` a filename with braces in it.
    log: granted.logPath,
    warnings: granted.warnings,
    admission: granted.admission,
  };
}

/** A fresh birth followed by the daemon's explicit session-error refusal. */
function bootRefusalAfterGrant(
  events: readonly WorkerBirthEvent[],
): { readonly workerId: string; readonly evidence: string } | null {
  const births = new Set<string>();
  for (const event of events) {
    if (event.kind === "worker-birth") {
      births.add(event.worker_id);
      continue;
    }
    if (
      event.kind === "worker-death" &&
      births.has(event.worker_id) &&
      event.detail?.startsWith("session-error:")
    ) {
      return { workerId: event.worker_id, evidence: event.detail };
    }
  }
  return null;
}
