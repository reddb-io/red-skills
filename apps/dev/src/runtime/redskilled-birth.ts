// redskilled-birth — the ONE place a project asks the host for a Worker
// (issue #2851, Spec #2772, ADR 0130).
//
// Before this module the daemon existed and nothing called it: every Worker was
// still born by the per-project runtime's own `spawn`, so the host budget, the
// per-Worker resource unit and the host event lane were code nobody reached.
// This is the crossing. **After it, a project that cannot reach the daemon
// starts nothing** — ADR 0130 rule 6, fail closed. A local fallback here would
// reinstate exactly the unbudgeted spawn the daemon exists to prevent, and would
// do it invisibly, which is the shape #2784 left behind.
//
// The module holds no work knowledge and no process mechanism. It resolves the
// project's own opaque label, hands the daemon an argv and a workspace path, and
// reports back what the host granted. Which ticket that Worker claims, which
// runner serves it and what its prompt says never enter here (rule 2), and
// neither does the spawn — the daemon owns birth, this only asks for it.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  declaredProjectNameInConfig,
  resolveProjectIdentity,
  type ProjectIdentity,
} from "@reddb-io/shared/project-identity.js";
import {
  commandRedskilledWorker,
  ensureRedskilledDaemon,
  readRedskilledHostState,
  startRedskilledWorker,
  type RedskilledClientConfig,
} from "@reddb-io/redskilled/client";
import { resolveRedskilledPaths, type RedskilledPaths } from "@reddb-io/redskilled/paths";
import type { RedskilledWorkerSpec } from "@reddb-io/redskilled/worker-launch";
import { readRedskilledEvents, type RedskilledHostEvent } from "@reddb-io/redskilled/event-lane";

// Re-exported so a consumer of this port imports the host's vocabulary from the
// one module that owns the project's reach into it — a second import path for
// the same names is how two spellings of one boundary start.
export { RedskilledUnreachableError } from "@reddb-io/redskilled/client";
export type { RedskilledWorkerStarted } from "@reddb-io/redskilled/protocol";
export type { RedskilledHostEvent, RedskilledWorkerSpec };

/**
 * Resolve this checkout's project label — the one opaque string the daemon keys
 * a project by (ADR 0130 rule 11).
 *
 * Every input is collected here and the DECISION stays in the pure resolver, so
 * a checkout with no git, no remote and no declared name still resolves to a
 * stable label instead of failing. A git call that throws contributes nothing
 * rather than aborting the launch: an unlabelled Worker is worse than one
 * labelled by its directory.
 */
export function resolveProjectLabel(root: string): string {
  return resolveProjectIdentityForRoot(root).name;
}

/** The full identity, for a caller that needs the slug as well as the name. */
export function resolveProjectIdentityForRoot(root: string): ProjectIdentity {
  const declaredName = readDeclaredProjectName(root);
  const gitCommonDir = gitOutput(root, ["rev-parse", "--absolute-git-dir"]) ??
    gitOutput(root, ["rev-parse", "--git-common-dir"]);
  const remoteUrl = gitOutput(root, ["remote", "get-url", "origin"]);
  return resolveProjectIdentity({
    checkoutPath: root,
    ...(gitCommonDir !== undefined ? { gitCommonDir } : {}),
    ...(remoteUrl !== undefined ? { remoteUrl } : {}),
    ...(declaredName !== undefined ? { declaredName } : {}),
  });
}

function readDeclaredProjectName(root: string): string | undefined {
  try {
    return declaredProjectNameInConfig(readFileSync(join(root, ".red", "config.yaml"), "utf8"));
  } catch {
    return undefined;
  }
}

function gitOutput(root: string, args: readonly string[]): string | undefined {
  try {
    const out = execFileSync("git", [...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out === "" ? undefined : out;
  } catch {
    return undefined;
  }
}

/** A Worker the host granted, in the two facts the project needs back. */
export interface GrantedWorkerBirth {
  readonly workerId: string;
  readonly pid: number;
  /** Warnings the host attached — a downgraded unit is running AND degraded. */
  readonly warnings: readonly string[];
  /** The host's own sentence about the ceiling that admitted this birth. */
  readonly admission: string;
}

/**
 * The project's reach into the host daemon.
 *
 * Every method fails closed: a daemon that does not answer throws
 * {@link RedskilledUnreachableError} and nothing is started, stopped or counted
 * from a private source.
 */
export interface RedskilledBirthPort {
  readonly projectLabel: string;
  readonly socketPath: string;
  /** Prove the daemon answers, starting it when it is not yet running. */
  reach(): Promise<void>;
  /** Ask for one Worker. A refusal throws; the project never spawns instead. */
  start(spec: RedskilledWorkerSpec): Promise<GrantedWorkerBirth>;
  /** Ask the host to end one Worker. The kill is the daemon's, the policy is ours. */
  stop(workerId: string, detail: string): Promise<boolean>;
  /** How many Workers this project holds on the host, as the host counts them. */
  liveWorkers(): Promise<number>;
  /**
   * Host events appended since the last drain, narrowed to this project.
   *
   * The lane is the daemon's record of birth, death and budget-kill, so a death
   * the project reacts to is one the HOST observed — never one inferred from a
   * pid this process happens to still remember.
   */
  drainEvents(): Promise<readonly RedskilledHostEvent[]>;
}

export interface CreateRedskilledBirthOptions {
  readonly root: string;
  /** Overrides the derived label; a caller that already resolved it passes it. */
  readonly projectLabel?: string;
  readonly paths?: RedskilledPaths;
  readonly config?: RedskilledClientConfig;
}

/**
 * Build the project's birth port.
 *
 * The session project is stated once, in the client config, so every request
 * carries it and the host's asymmetric reach rule (ADR 0130 rule 9) has
 * something to refuse: this port reads the whole host and writes only its own
 * project.
 */
export function createRedskilledBirthPort(options: CreateRedskilledBirthOptions): RedskilledBirthPort {
  const projectLabel = options.projectLabel ?? resolveProjectLabel(options.root);
  const paths = options.paths ?? resolveRedskilledPaths();
  const config: RedskilledClientConfig = { ...options.config, sessionProject: projectLabel };
  // The lane is append-only, so a cursor over what we already read is all the
  // state a drain needs — and a cursor that is re-derived from the lane's own
  // length can never replay a death the breaker already counted.
  let drained = 0;

  return {
    projectLabel,
    socketPath: paths.socketPath,

    async reach() {
      await ensureRedskilledDaemon(paths, config);
    },

    async start(spec) {
      const started = await startRedskilledWorker(paths, { ...spec, project_label: projectLabel }, config);
      return {
        workerId: started.worker.worker_id,
        pid: started.worker.pid,
        warnings: started.warnings,
        admission: started.admission.reason,
      };
    },

    async stop(workerId, detail) {
      const result = await commandRedskilledWorker(paths, { command: "stop", worker_id: workerId, detail }, config);
      return result.applied;
    },

    async liveWorkers() {
      const state = await readRedskilledHostState(paths, config);
      return state.workers.filter((worker) => worker.project_label === projectLabel).length;
    },

    async drainEvents() {
      // Read-only and lane-local: an event drain must not start a daemon, or a
      // project asking what died would birth the very authority it is asking.
      const events = await readRedskilledEvents(paths.eventLanePath);
      const fresh = events.slice(drained);
      drained = events.length;
      return fresh.filter((event) => event.project_label === projectLabel);
    },
  };
}

/**
 * The one sentence a surface prints when the host did not answer.
 *
 * Exported so the launch path, the supervisor and the canary all route an
 * operator to the same repair — "start the daemon" and "fix the client that
 * stopped asking it" are different jobs, and the socket path is what tells them
 * apart.
 */
export function redskilledUnreachableAdvice(socketPath: string, cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return (
    `no Worker was started: the redskilled daemon did not answer on ${socketPath}. ` +
    `Since ADR 0130 the daemon owns every birth, so a project that cannot reach it starts nothing ` +
    `rather than spawning an unbudgeted Worker of its own. Run \`redskilled provision\` (or ` +
    `\`/red-setup\`) to install it, then retry. (${detail})`
  );
}
