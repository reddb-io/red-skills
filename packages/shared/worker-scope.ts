/**
 * worker-scope — the resource scope a process was born into, told to the process.
 *
 * **A scope only attributes a kill if the dying process can name it.** The host
 * decides where a Worker is placed and what ceiling it carries, and until this
 * module existed that knowledge stopped at the daemon: the Worker itself ran with
 * no idea which unit held it, so its own death record — the one artifact written
 * by the thing that died — could not say what contained it (Spec #3022, #3029).
 *
 * The contract is the Worker's identity and birth instant plus three placement
 * facts, stated by the host at birth and read by the Worker on the way out.
 * Environment rather than a file because a
 * transient unit already carries `--setenv` and a Worker that had to find a file
 * would have to learn a layout the daemon deliberately does not teach it.
 *
 * **A host that could not scope the birth states WHY, in the same breath.** The
 * degradation is a third variable rather than an absent scope, because "no scope"
 * and "no scope, and here is the host fact that prevented one" are different
 * answers and only the second one is debuggable.
 *
 * PURE: every function takes the environment it reads.
 */

/** The unit or job the process runs inside, when the host gave it one. */
export const WORKER_SCOPE_ENV = "RED_WORKER_SCOPE";

/** The memory ceiling that scope carries, in the host's own notation. */
export const WORKER_SCOPE_CEILING_ENV = "RED_WORKER_MEMORY_CEILING";

/** Why the process is unscoped, when it is — never an absent scope alone. */
export const WORKER_SCOPE_DEGRADATION_ENV = "RED_WORKER_SCOPE_DEGRADATION";

/** The daemon-minted Worker identity carried by every process it births. */
export const WORKER_ID_ENV = "RED_WORKER_ID";

/** The daemon clock instant at which this Worker was born. */
export const WORKER_BORN_AT_ENV = "RED_WORKER_BORN_AT";

/** Stable attribution stamped onto a Worker's environment at birth. */
export interface WorkerAttributionFacts {
  readonly worker_id: string;
  readonly born_at: string;
}

/**
 * Where a process runs and under what ceiling.
 *
 * Total: every field is present and `null` where it genuinely does not apply, so
 * a reader never has to tell "the host said nothing" from "the field is missing".
 */
export interface WorkerScopeFacts {
  /** The resource scope containing this process, or `null` when it has none. */
  readonly scope: string | null;
  /** The ceiling that scope enforces, verbatim as the host stated it. */
  readonly memory_ceiling: string | null;
  /** Why there is no scope, when there is none. */
  readonly scope_degradation: string | null;
}

/** A process nobody placed — the answer for every host that states nothing. */
export const UNSCOPED_PROCESS: WorkerScopeFacts = {
  scope: null,
  memory_ceiling: null,
  scope_degradation: null,
};

/**
 * Read the scope facts out of an environment. PURE.
 *
 * A blank value reads as absent rather than as an empty scope: an inherited
 * `RED_WORKER_SCOPE=` would otherwise make an unscoped process claim a scope
 * whose name is the empty string, which no surface could look up.
 */
export function readWorkerScopeFacts(env: NodeJS.ProcessEnv): WorkerScopeFacts {
  return {
    scope: stated(env[WORKER_SCOPE_ENV]),
    memory_ceiling: stated(env[WORKER_SCOPE_CEILING_ENV]),
    scope_degradation: stated(env[WORKER_SCOPE_DEGRADATION_ENV]),
  };
}

/**
 * The environment a host hands a Worker so it can read its attribution and
 * placement. PURE.
 *
 * A fact the host does not have is OMITTED rather than set empty, so the Worker
 * inherits nothing it would have to reinterpret.
 */
export function workerScopeEnvironment(
  facts: WorkerScopeFacts,
  attribution?: WorkerAttributionFacts,
): Record<string, string> {
  const environment: Record<string, string> = {};
  if (attribution != null) {
    environment[WORKER_ID_ENV] = attribution.worker_id;
    environment[WORKER_BORN_AT_ENV] = attribution.born_at;
  }
  if (facts.scope != null && facts.scope !== "") environment[WORKER_SCOPE_ENV] = facts.scope;
  if (facts.memory_ceiling != null && facts.memory_ceiling !== "") {
    environment[WORKER_SCOPE_CEILING_ENV] = facts.memory_ceiling;
  }
  if (facts.scope_degradation != null && facts.scope_degradation !== "") {
    environment[WORKER_SCOPE_DEGRADATION_ENV] = facts.scope_degradation;
  }
  return environment;
}

function stated(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}
