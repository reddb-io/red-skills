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

import { canonicalInvocation } from "@reddb-io/shared/canonical-invocation.js";
import {
  resolveProjectIdentityForDir,
  resolveProjectLabelForDir,
} from "@reddb-io/shared/project-identity-resolve.js";
import type { ProjectIdentity } from "@reddb-io/shared/project-identity.js";
import {
  commandRedskilledWorker,
  deregisterRedskilledProject,
  ensureRedskilledDaemon,
  registerRedskilledProject,
  renewRedskilledProject,
  readRedskilledHostState,
  startRedskilledWorker,
  type RedskilledClientConfig,
} from "@reddb-io/redskilled/client";
import { resolveRedskilledPaths, type RedskilledPaths } from "@reddb-io/redskilled/paths";
import type {
  RedskilledProjectRegistration,
  RedskilledProjectRegistrationRequest,
} from "@reddb-io/redskilled/project-registration";
import type { RedskilledWorkerSpec } from "@reddb-io/redskilled/worker-launch";
import { readRedskilledEvents, type RedskilledHostEvent } from "@reddb-io/redskilled/event-lane";
import type { RedskilledRegistrationView } from "@reddb-io/redskilled/host-state";
import type { RedskilledLaunchTemplate } from "@reddb-io/redskilled/launch-template";

// Re-exported so a consumer of this port imports the host's vocabulary from the
// one module that owns the project's reach into it — a second import path for
// the same names is how two spellings of one boundary start.
export { RedskilledUnreachableError } from "@reddb-io/redskilled/client";
export type { RedskilledWorkerStarted } from "@reddb-io/redskilled/protocol";
export type {
  RedskilledHostEvent,
  RedskilledWorkerSpec,
  RedskilledProjectRegistration,
  RedskilledRegistrationView,
  RedskilledLaunchTemplate,
};

/**
 * A registration as the PROJECT states it — everything but its own label.
 *
 * The label is the port's, not the caller's: a surface that could state it would
 * be a surface that could register another project by typo, and the daemon would
 * believe it (ADR 0130 rule 11).
 */
export type ProjectRegistrationRequest = Omit<RedskilledProjectRegistrationRequest, "project_label">;

/**
 * Resolve this checkout's project label — the one opaque string the daemon keys
 * a project by (ADR 0130 rule 11).
 *
 * **The collection lives in `@reddb-io/shared`, not here.** It used to live in
 * this file, and the statusline grew its own shorter version that read only a
 * declared `project.name`: two answers to "where am I", diverging silently until
 * a repository that declared no name filed its Workers under one label and asked
 * about another (#2928). One resolver, imported by both.
 */
export function resolveProjectLabel(root: string): string {
  return resolveProjectLabelForDir(root);
}

/** The full identity, for a caller that needs the slug as well as the name. */
export function resolveProjectIdentityForRoot(root: string): ProjectIdentity {
  return resolveProjectIdentityForDir(root);
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
  /**
   * State this project's presence: what work it wants and what to run for it.
   *
   * The project's whole contribution since ADR 0130 Amendment 4 — a record the
   * daemon holds instead of a process the project launched. Both strings are
   * opaque to the host; a refusal throws, and nothing is started instead.
   */
  register(request: ProjectRegistrationRequest): Promise<RedskilledProjectRegistration>;
  /**
   * Say this session is still here, so the registration keeps standing.
   *
   * The registration outlives this session on purpose — a drain has to survive
   * the operator closing the terminal — and the renewal is the only reason it
   * does not outlive it forever. A refusal throws, including the one that says
   * the record lapsed: a session that read that as renewed would keep renewing
   * nothing while its work sat undrained, and its next move is to register again.
   */
  renew(): Promise<RedskilledProjectRegistration>;
  /**
   * Restate what the NEXT Worker is started with, on the renewal (Amendment 5).
   *
   * A Worker's runner, model tier and effort are decided per BIRTH, not per
   * project, so the one argv a registration carries has to be restatable — a
   * tick that swapped the runner sends the new pair rather than deregistering
   * and re-registering, which would leave the host holding no record of a
   * project that is still draining. Restating is all-or-nothing: an argv given
   * without an env replaces the env with none.
   */
  restateLaunch(launch: RedskilledLaunchTemplate): Promise<RedskilledProjectRegistration>;
  /**
   * Take this project's presence back. Reports whether a record stood.
   *
   * `false` is an answer, not a fault: work stops from two directions — an
   * operator and a session that ends — and the second one must read as done.
   */
  deregister(): Promise<boolean>;
  /** Ask the host to end one Worker. The kill is the daemon's, the policy is ours. */
  stop(workerId: string, detail: string): Promise<boolean>;
  /**
   * The registration the host holds for this project, or `null` for none.
   *
   * The answer to "is this project's work being driven", now that a project
   * contributes a record rather than a process (ADR 0130 Amendment 4, #2909).
   * `null` is a real answer — the host is reachable and holds nothing — and it
   * is distinct from the throw a caller gets when the host does not answer at
   * all, which is the distinction a reader needs to know where to look next.
   */
  registration(): Promise<RedskilledRegistrationView | null>;
  /** How many Workers this project holds on the host, as the host counts them. */
  liveWorkers(): Promise<number>;
  /**
   * WHICH Workers this project holds, as the host names them.
   *
   * The list rather than the count, for the caller that has to act on each one:
   * stopping this project's work means naming its Workers to the daemon, and a
   * project that could only count them would have to guess at ids or reach for
   * pids of its own — which is the unadmitted, uncounted path ADR 0130 removed.
   */
  workerIds(): Promise<readonly string[]>;
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

  /** This project's Workers, as the host names them. One read, two callers. */
  const readProjectWorkerIds = async (): Promise<readonly string[]> => {
    const state = await readRedskilledHostState(paths, config);
    return state.workers
      .filter((worker) => worker.project_label === projectLabel)
      .map((worker) => worker.worker_id);
  };

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

    async register(request) {
      const registered = await registerRedskilledProject(
        paths,
        { ...request, project_label: projectLabel },
        config,
      );
      return registered.registration;
    },

    async renew() {
      const renewed = await renewRedskilledProject(paths, { project_label: projectLabel }, config);
      return renewed.registration;
    },

    async restateLaunch(launch) {
      const renewed = await renewRedskilledProject(paths, { project_label: projectLabel, launch }, config);
      return renewed.registration;
    },

    async deregister() {
      const released = await deregisterRedskilledProject(paths, { project_label: projectLabel }, config);
      return released.released;
    },

    async stop(workerId, detail) {
      const result = await commandRedskilledWorker(paths, { command: "stop", worker_id: workerId, detail }, config);
      return result.applied;
    },

    async registration() {
      const state = await readRedskilledHostState(paths, config);
      return (state.registrations ?? []).find((held) => held.project_label === projectLabel) ?? null;
    },

    async liveWorkers() {
      return (await readProjectWorkerIds()).length;
    },

    async workerIds() {
      return await readProjectWorkerIds();
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
/**
 * The one sentence a project prints when it could not register itself.
 *
 * A sibling of {@link redskilledUnreachableAdvice} rather than a reuse of it,
 * because the two refusals leave different states behind: that one says no Worker
 * was born, this one says the project has no presence at all. Both name the
 * socket, because "start the daemon" and "fix the client that stopped asking it"
 * are still the two repairs, and the socket is what tells them apart.
 */
export function redskilledRegistrationRefusal(socketPath: string, cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return (
    `this project was not registered: the redskilled daemon did not answer on ${socketPath}. ` +
    `Since ADR 0130 Amendment 4 a project contributes a registration rather than a process, so a project ` +
    `that cannot reach the daemon starts nothing rather than launching a demand producer no host admitted, ` +
    `counts or can stop. Run \`${canonicalInvocation("red-skills-redskilled", ["provision"])}\` ` +
    `(or \`/red-setup\`) to install it, then retry. (${detail})`
  );
}

export function redskilledUnreachableAdvice(socketPath: string, cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return (
    `no Worker was started: the redskilled daemon did not answer on ${socketPath}. ` +
    `Since ADR 0130 the daemon owns every birth, so a project that cannot reach it starts nothing ` +
    `rather than spawning an unbudgeted Worker of its own. Run ` +
    `\`${canonicalInvocation("red-skills-redskilled", ["provision"])}\` (or \`/red-setup\`) to install it, ` +
    `then retry. (${detail})`
  );
}
