/**
 * launch-template — how one frozen registration still births differing Workers.
 *
 * ADR 0130 Amendment 4 moves birth onto the registration, and a registration
 * carries **one** argv. But a Worker's runner, its model tier, its effort, its
 * retire file and its slot are all decided per birth today: the runner because a
 * runner can degrade mid-drain and the directive is applied on a tick rather than
 * at launch, the slot-scoped env because two Workers of one project must not
 * share a build directory or a retire file. **One fixed argv per project cannot
 * express a decision made per Worker**, and freezing them at registration time
 * would lose the capability rather than move it.
 *
 * **Decision (Amendment 5): a launch is RESTATED, not frozen.** The registration
 * carries an opaque launch template — an argv and an env — that the project
 * rotates on the renewal its session already sends every half-window, and the
 * daemon expands per birth by substituting the handful of facts it already owns.
 * Every project-meaningful word is authored by the project and carried verbatim;
 * the daemon's whole contribution is textual substitution of its own facts.
 *
 * **Why this shape, and not the two next to it.** *Asking the project per grant*
 * preserves everything, but the daemon holds no connection to a session — every
 * request arrives on its own socket — so it would need a reverse channel it does
 * not have, would reinstate the round trip the demand loop exists to remove, and
 * would make every birth fail while a session is momentarily blocked, when the
 * whole point is that a drain outlives its terminal. *Re-registering to swap*
 * needs no new field, but the daemon refuses a duplicate registration, so a swap
 * is a deregister followed by a register and the window between them is a state
 * where the host holds no record of a project that is still draining. Rotating on
 * the renewal costs no new op, no round trip and no window: the renewal is a
 * message the live session already sends, and a registration with nothing to
 * restate is exactly the renewal that exists today.
 *
 * **Rule 3 survives intact.** The daemon does not learn what a runner, a model or
 * an effort is. It knows four facts about a birth — the Worker's id, its slot, its
 * workspace and its log path — and the only question it asks a template word is
 * whether that word mentions one of them. A word that mentions none is copied.
 *
 * **An unknown fact is refused, never passed through.** A Worker born with a
 * literal `{{tier}}` in its argv is a Worker nobody meant to start, and the shape
 * of that mistake is a typo in a client — so it fails closed at expansion, with
 * the name it did not recognise and the ones it knows.
 *
 * PURE: every input is passed in, the facts included.
 */

/**
 * The facts the daemon may substitute into a launch — and the whole of them.
 *
 * Each one is something the daemon owns at the instant of birth and the project
 * cannot know in advance: the Worker's id is minted per birth, the slot is chosen
 * per placement, and the workspace and log path are the ones the host will
 * actually use. Nothing here is work knowledge, which is why the list can be
 * frozen: a fifth entry would have to be a fact the daemon owns, and there is no
 * runner, model or effort among those.
 */
export const REDSKILLED_LAUNCH_FACTS = ["worker_id", "slot", "workspace_path", "log_path"] as const;

export type RedskilledLaunchFactName = (typeof REDSKILLED_LAUNCH_FACTS)[number];

/** The facts one birth supplies. The daemon's own, never the project's. */
export interface RedskilledLaunchFacts {
  readonly worker_id: string;
  readonly slot: number;
  readonly workspace_path: string;
  readonly log_path?: string | undefined;
}

/**
 * What a project states about how its Workers are started.
 *
 * Opaque in all three parts: the argv is the argv the daemon already carried, the
 * env is the slot-scoped bag that used to be composed at the spawn site, and the
 * log path is a filename. None is read — the env is a map only because a process
 * environment is one, not because the daemon looks anything up in it.
 *
 * **The log path is stated here because the registration lane has nowhere else to
 * state it** (#3079). `log_path` was always one of the four facts a birth
 * supplies, but only the direct `worker-start` lane could supply it: a project
 * that registers hands over a template and then never hears about a birth again,
 * so a Worker born from a registration reached every surface carrying no path,
 * and each surface reported the absence as a Worker with nothing to say.
 */
export interface RedskilledLaunchTemplate {
  readonly argv: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Where this project's NEXT Worker writes its output — a template, like the rest.
   *
   * Stated with `{{worker_id}}` in it in the ordinary case, because one template
   * serves every Worker of a project and two Workers must never be handed one
   * file. The daemon opens it and pipes the Worker's stdout and stderr into it,
   * so it must name a file the project does not otherwise write: a path already
   * owned by a project-side writer would be two writers interleaving into one
   * file.
   */
  readonly log_path?: string;
}

/** One launch, with every fact filled in. */
export interface RedskilledExpandedLaunch {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** The template's own log path with the facts written in; absent when it stated none. */
  readonly log_path?: string;
}

/** Raised when a template names a fact the daemon does not have. Fail closed. */
export class RedskilledLaunchFactError extends Error {
  constructor(
    readonly fact: string,
    where: string,
  ) {
    super(
      `redskilled cannot expand ${JSON.stringify(`{{${fact}}}`)} in ${where}: the facts a birth supplies are ` +
        `${REDSKILLED_LAUNCH_FACTS.join(", ")}, and a Worker started with the placeholder left in it is one nobody ` +
        `meant to start`,
    );
    this.name = "RedskilledLaunchFactError";
  }
}

const PLACEHOLDER = /\{\{([a-z_]+)\}\}/g;

/**
 * Fill one launch template's facts in, for one birth. PURE.
 *
 * The substitution is textual and total: every word of the argv and every value
 * of the env goes through the same pass, and a word that mentions no fact comes
 * out the word that went in. That is the property the daemon's ignorance rests
 * on — the output is the input with the daemon's own facts written into it, and
 * there is nowhere in this function for an opinion about a runner to live.
 */
export function expandLaunchTemplate(
  template: RedskilledLaunchTemplate,
  facts: RedskilledLaunchFacts,
): RedskilledExpandedLaunch {
  const substitute = (value: string, where: string): string =>
    value.replace(PLACEHOLDER, (match, name: string) => {
      switch (name) {
        case "worker_id":
          return facts.worker_id;
        case "slot":
          return String(facts.slot);
        case "workspace_path":
          return facts.workspace_path;
        case "log_path":
          // An absent log path expands to nothing rather than to the string
          // "undefined": a client that mentioned it and did not supply it wants
          // an empty value, not a filename spelled after a JavaScript keyword.
          return facts.log_path ?? "";
        default:
          throw new RedskilledLaunchFactError(name, where);
      }
    });

  const argv = template.argv.map((word, index) => substitute(word, `argv word ${index}`));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(template.env ?? {})) {
    env[key] = substitute(value, `env entry ${JSON.stringify(key)}`);
  }
  const logPath = template.log_path == null ? undefined : substitute(template.log_path, "the log path");
  return { argv, env, ...(logPath == null || logPath === "" ? {} : { log_path: logPath }) };
}

/**
 * Turn one project's standing launch into the spec for ONE Worker. PURE.
 *
 * This is the composition site the per-project process used to be: the argv's
 * first word is the command and the rest are its arguments, exactly as they were
 * when a spawn site assembled them, and the env is the slot-scoped bag that site
 * used to build. What moved is WHO composes it — the daemon, from strings the
 * project authored — and what did not move is what any of those strings mean.
 *
 * The Worker's id is stated rather than left to the daemon to mint, because the
 * template may mention it: an id substituted into an argv and a different id on
 * the record would be one Worker the host and the work disagree about.
 */
export function workerSpecFromLaunch(
  template: RedskilledLaunchTemplate,
  facts: RedskilledLaunchFacts,
  project: { readonly project_label: string },
): {
  readonly worker_id: string;
  readonly project_label: string;
  readonly workspace_path: string;
  readonly log_path?: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
} {
  const launch = expandLaunchTemplate(template, facts);
  // The template's own statement wins over the fact, because the fact exists for
  // the lane that has no template: a caller holding both is a caller that stated
  // where its Worker logs, and the daemon's default must not overrule it.
  const logPath = launch.log_path ?? facts.log_path;
  const [command, ...args] = launch.argv;
  if (command === undefined || command === "") {
    throw new Error(
      `redskilled cannot start a Worker for project ${JSON.stringify(project.project_label)}: its launch expanded to ` +
        `an argv with no command`,
    );
  }
  return {
    worker_id: facts.worker_id,
    project_label: project.project_label,
    workspace_path: facts.workspace_path,
    ...(logPath == null || logPath === "" ? {} : { log_path: logPath }),
    command,
    args,
    env: launch.env,
  };
}

/**
 * Check an argv's SHAPE, and never its meaning. PURE.
 *
 * The daemon asks whether it holds a non-empty list of non-empty strings, and
 * that is the last question it ever asks about an argv's content — exactly as it
 * asks of a selector. An empty argv is refused because a registration with
 * nothing to run is a project the host could never start a Worker for.
 */
export function requireLaunchArgv(argv: unknown, projectLabel: string): readonly string[] {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error(
      `redskilled needs an argv to register project ${JSON.stringify(projectLabel)}: a registration with nothing to ` +
        `run is a project the host could never start a Worker for`,
    );
  }
  return argv.map((word, index) => {
    if (typeof word !== "string" || word === "") {
      throw new Error(
        `redskilled needs every word of an argv to be a non-empty string, and word ${index} of project ` +
          `${JSON.stringify(projectLabel)} is not`,
      );
    }
    return word;
  });
}

/**
 * Check a declared log path's SHAPE, and never its meaning. PURE.
 *
 * Absence is legal and stays legal: the heartbeat is the primary supply of a
 * Worker's last line and needs no path at all, so a registration that declares
 * none is a project keeping the whole mechanism on the beat. What is refused is
 * a path stated as something other than a non-empty string — an empty one is a
 * client that meant to declare and did not, which is exactly the silence #3079
 * was: a `log_path` that expanded to `""` degraded four layers deep and every
 * one of them read the absence as legitimate.
 */
export function requireLaunchLogPath(value: unknown, projectLabel: string): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `redskilled needs a declared log path to be a non-empty string to register project ` +
        `${JSON.stringify(projectLabel)}, not ${JSON.stringify(value)}: a project that declares an empty path ` +
        `states a Worker whose output no surface can ever show, which reads as a Worker with nothing to say`,
    );
  }
  return value;
}

/**
 * Check a launch env's shape, and never its meaning. PURE.
 *
 * An empty env is ordinary — a project that adds nothing to what the daemon
 * already passes states `{}` — so absence and emptiness are the same answer here.
 * A value that is not a string is not: a process environment carries strings, and
 * a number silently stringified at the spawn site is a client bug the daemon can
 * see without reading anything.
 */
export function requireLaunchEnv(env: unknown, projectLabel: string): Readonly<Record<string, string>> {
  if (env == null) return {};
  if (typeof env !== "object" || Array.isArray(env)) {
    throw new Error(
      `redskilled needs a launch env to be a map of strings to register project ${JSON.stringify(projectLabel)}, not ` +
        `${JSON.stringify(env)}`,
    );
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (key === "") {
      throw new Error(`redskilled needs every launch env name of project ${JSON.stringify(projectLabel)} to be named`);
    }
    if (typeof value !== "string") {
      throw new Error(
        `redskilled needs every launch env value to be a string, and ${JSON.stringify(key)} of project ` +
          `${JSON.stringify(projectLabel)} is ${JSON.stringify(value)}`,
      );
    }
    out[key] = value;
  }
  return out;
}
