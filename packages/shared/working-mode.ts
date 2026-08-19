// working-mode — the four ways work enters RedSkills, and the marker a Worker
// exports so a skill can tell which one it is running inside (ADR 0150 §1–§2).
//
// The vocabulary was already written down once, as a guard over shipped skill
// headers (`apps/dev/src/core/working-mode-guard.ts`). It lives HERE now because
// a second reader needs it: the daemon, which exports the marker. Two hand-kept
// copies of a four-value closed set is the shape a fifth value gets added to one
// of them, and the marker a Worker exports must be the SAME string a skill
// header declares — otherwise a skill comparing the two never matches and the
// refusal ADR 0150 §2 asks for silently never fires.
//
// **Only two of the four modes are a Worker's.** Interactive and ADR-editing
// work happens in a human's checkout, where nobody exports anything; spec-driven
// and ad-hoc work is coordinated by `redskilled`, whose Workers run in OS
// temporary storage (ADR 0149) with no human attached. So the marker's absence
// is meaningful too — it says "not inside a Worker" — and this module never
// invents a value for a process that has none.

/** The four Working modes ADR 0150 §1 declares, in the ADR's own order. */
export const WORKING_MODES = ["interactive", "spec-driven", "ad-hoc", "ADR-editing"] as const;

/** One of the four ways work enters RedSkills. */
export type WorkingMode = (typeof WORKING_MODES)[number];

/** The environment name a Worker exports its Working mode under. */
export const RED_MODE_ENV = "RED_MODE";

/**
 * The two modes a Worker can be in. A Worker exists because the daemon admitted
 * one, and the daemon is only ever asked for spec-driven or ad-hoc work.
 */
export const WORKER_WORKING_MODES: readonly WorkingMode[] = ["spec-driven", "ad-hoc"];

/** The governed kinds of dispatch a Worker is born for (`AcpWorkerKind`). */
export type WorkerDispatchKind = "afk" | "go" | "scout";

/**
 * The Working mode a dispatch kind runs in.
 *
 * `go` is the one ad-hoc entrance (ADR 0081): one demand, one Ticket, straight
 * to the daemon. `afk` drains the spec-driven queue and `scout` investigates an
 * issue that queue produced, so both are spec-driven. **An absent kind is
 * spec-driven too**, because a Worker with no targeted dispatch was admitted by
 * the drain — never by `/go`, which cannot dispatch without naming its Ticket.
 */
export function workingModeOfWorkerKind(kind?: WorkerDispatchKind): WorkingMode {
  return kind === "go" ? "ad-hoc" : "spec-driven";
}

/**
 * The environment a Worker's mode contributes, as the daemon merges it into the
 * launch spec. One name, one value, no ambient read: the caller states the kind.
 */
export function workerModeEnv(kind?: WorkerDispatchKind): Readonly<Record<string, string>> {
  return { [RED_MODE_ENV]: workingModeOfWorkerKind(kind) };
}

/**
 * The mode this process is running in, or `undefined` when it is not inside a
 * Worker at all. An unrecognised value is `undefined` rather than a guess: a
 * skill gating on the marker must not be steered by a string nobody declared.
 */
export function declaredWorkingMode(env: NodeJS.ProcessEnv): WorkingMode | undefined {
  const declared = env[RED_MODE_ENV]?.trim();
  return WORKING_MODES.find((mode) => mode === declared);
}
