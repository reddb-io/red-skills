/**
 * session-reach — read the host, write the project (ADR 0130 rule 9).
 *
 * **Reach is asymmetric, and the asymmetry is the point.** Seeing the machine is
 * a requirement of the problem the daemon exists to solve: an operator diagnosing
 * contention must be able to read every project's Workers from whichever session
 * they happen to be in, and two readers of the same instant must not be able to
 * report different answers. Commanding the machine never was a requirement — and
 * these sessions are largely driven by autonomous agents that do not understand a
 * repository they were not started in, so a blast radius wider than the checkout
 * is a defect waiting for a bad afternoon.
 *
 * So every op lands in exactly one of three reaches. A **host-read** is permitted
 * from anywhere. A **project-write** — dispatch, stop, recycle, steer — is
 * permitted only into the session's own project. **Daemon-life** is the daemon's
 * own process rather than any project's Workers, and it is named here rather than
 * folded into either so that "which ops are project-scoped" stays a closed list.
 *
 * **A refusal never says what it is refusing about.** An unknown target is
 * refused with the same shape as a cross-project one, because a session that
 * could tell "no such Worker" from "not your Worker" would learn another
 * project's Worker set by guessing at it.
 *
 * This is a blast-radius guard between honest clients on one user's own session
 * socket, not an authentication boundary: the daemon believes the project a
 * session states about itself, exactly as it believes every other opaque string
 * a client hands it (ADR 0130 rule 3).
 *
 * PURE: every input is passed in.
 */

/** Every op the reach model classifies, including the ones no mechanism serves yet. */
export type RedskilledSessionOp =
  | "ping"
  | "host-state"
  | "statusline-payload"
  | "shutdown"
  | "worker-start"
  | "worker-stop"
  | "worker-recycle"
  | "worker-steer"
  | "worker-heartbeat"
  | "project-register"
  | "project-deregister";

/** The three reaches. A reader of this type knows the whole model. */
export type RedskilledReachKind = "host-read" | "project-write" | "daemon-life";

/** The closed classification. Adding an op means deciding its reach here, first. */
export const REDSKILLED_OP_REACH: Readonly<Record<RedskilledSessionOp, RedskilledReachKind>> = {
  ping: "host-read",
  "host-state": "host-read",
  "statusline-payload": "host-read",
  shutdown: "daemon-life",
  "worker-start": "project-write",
  "worker-stop": "project-write",
  "worker-recycle": "project-write",
  "worker-steer": "project-write",
  // A heartbeat is a Worker telling the daemon about itself, so it lands where
  // every other statement about a Worker lands: inside its own project. A
  // cross-project publish would let one session write a line another session's
  // statusline then shows as that project's own.
  "worker-heartbeat": "project-write",
  // A registration is a project stating what work it wants done and what to run
  // for it, so it lands where every other statement about a project lands: inside
  // that project. A cross-project registration would let one session commit
  // another project's name to an argv it never chose.
  "project-register": "project-write",
  // Releasing one lands exactly where taking it did: a session that could release
  // another project's registration could stop its work from outside it.
  "project-deregister": "project-write",
};

/** The commanding verbs, as a session names them. Each maps onto one write op. */
export type RedskilledWorkerCommandName = "stop" | "recycle" | "steer";

/** The write op one commanding verb reaches through. PURE. */
export function commandOp(command: RedskilledWorkerCommandName): RedskilledSessionOp {
  return `worker-${command}` as RedskilledSessionOp;
}

export type RedskilledReachVerdictKind =
  | "permitted-host-read"
  | "permitted-daemon-life"
  | "permitted-own-project"
  | "permitted-unattributed"
  | "refused-cross-project";

/**
 * The answer, carrying what it was decided on.
 *
 * `reason` is a whole sentence for the same reason an admission refusal is: this
 * string is what an operator reads when their command did not happen.
 */
export interface RedskilledReachVerdict {
  readonly version: 1;
  readonly permitted: boolean;
  readonly verdict: RedskilledReachVerdictKind;
  readonly op: RedskilledSessionOp;
  readonly reach: RedskilledReachKind;
  /** The project the session says it is; `null` when it said nothing. */
  readonly session_project: string | null;
  /** The project the op would act on; `null` when there is no such target. */
  readonly target_project: string | null;
  readonly reason: string;
}

export interface EvaluateSessionReachInput {
  readonly op: RedskilledSessionOp;
  /** The project the session states about itself; absent means unattributed. */
  readonly sessionProject?: string | null;
  /** The project the target Worker belongs to; `null` when the target is unknown. */
  readonly targetProject?: string | null;
}

/**
 * Decide one op's reach.
 *
 * An unattributed write — a session that stated no project — is permitted, and
 * says so in its own verdict: the daemon has nothing to compare against, and
 * refusing every legacy caller would take the machine down to enforce a guard
 * that only ever mattered against a session that DID name a different project.
 * PURE.
 */
export function evaluateSessionReach(input: EvaluateSessionReachInput): RedskilledReachVerdict {
  const reach = REDSKILLED_OP_REACH[input.op] ?? "project-write";
  const sessionProject = input.sessionProject ?? null;
  const targetProject = input.targetProject ?? null;
  const base = { version: 1, op: input.op, reach, session_project: sessionProject, target_project: targetProject } as const;

  if (reach === "host-read") {
    return {
      ...base,
      permitted: true,
      verdict: "permitted-host-read",
      reason: `redskilled permitted ${input.op}: a session reads the whole host, whichever project it was started in`,
    };
  }
  if (reach === "daemon-life") {
    return {
      ...base,
      permitted: true,
      verdict: "permitted-daemon-life",
      reason: `redskilled permitted ${input.op}: it acts on the daemon's own process, not on any project's Workers`,
    };
  }
  if (sessionProject == null || sessionProject === "") {
    return {
      ...base,
      permitted: true,
      verdict: "permitted-unattributed",
      reason: `redskilled permitted ${input.op}: the session named no project of its own, so there is nothing to refuse it against`,
    };
  }
  if (targetProject != null && targetProject === sessionProject) {
    return {
      ...base,
      permitted: true,
      verdict: "permitted-own-project",
      reason: `redskilled permitted ${input.op}: the target belongs to project ${JSON.stringify(sessionProject)}, which is this session's own`,
    };
  }
  return {
    ...base,
    permitted: false,
    verdict: "refused-cross-project",
    reason: `redskilled refused ${input.op} from a session in project ${JSON.stringify(sessionProject)}: ` +
      `${targetProject == null ? "it names no Worker of that project" : `the target belongs to project ${JSON.stringify(targetProject)}`}. ` +
      `A session reads the whole host and writes only its own project.`,
  };
}

/** True when `value` is a complete reach verdict — a client's fail-closed check. */
export function isRedskilledReachVerdict(value: unknown): value is RedskilledReachVerdict {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const verdict = value as Record<string, unknown>;
  return verdict.version === 1 &&
    typeof verdict.permitted === "boolean" &&
    typeof verdict.verdict === "string" &&
    typeof verdict.op === "string" &&
    typeof verdict.reach === "string" &&
    (verdict.session_project === null || typeof verdict.session_project === "string") &&
    (verdict.target_project === null || typeof verdict.target_project === "string") &&
    typeof verdict.reason === "string";
}
