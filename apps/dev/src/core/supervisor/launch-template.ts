/**
 * launch-template — the project's side of a per-birth decision, stated as data.
 *
 * ADR 0130 Amendment 5: **a launch is restated, not frozen.** The registration
 * the daemon holds carries an argv and an env, and a project rotates them on the
 * renewal its session already sends. This module is what a tick calls to say what
 * the NEXT Worker should be started with — the same composition the spawn site
 * used to do at the instant of birth, moved one step earlier and made pure.
 *
 * **The runner is a word in the argv, and that is the whole of the swap.** A
 * runner directive that landed this tick produces a template whose `--runner`
 * word is the new runner; the daemon stores it, expands it and starts a process
 * with it, having asked nothing about what the word says. Nothing needs to
 * restart, and no Worker already running is disturbed — a directive changes the
 * NEXT birth, exactly as it did when it was applied on a tick rather than at
 * launch.
 *
 * **Model and effort are not here, and that is deliberate.** They resolve per
 * tier, per run, inside the Worker — `resolveTier(config, runner, taskClass)`
 * reads the project's own config in the workspace it was born into. What this
 * template owes them is the one input they take from outside: the runner. Baking
 * a model into the argv would freeze at the tick what the run resolves per task
 * class, which is the freezing this amendment exists to avoid.
 *
 * **The per-birth facts are placeholders, not values.** A slot, a worker id and a
 * retire file differ for every Worker of one project, so the template states them
 * as `{{slot}}` and `{{worker_id}}` and the daemon writes its own facts in. A
 * template that stated a slot would be a template good for exactly one Worker.
 *
 * PURE: every input is passed in, the interpreter path included.
 */
import type { RedskilledLaunchTemplate } from "@reddb-io/redskilled/launch-template";

/** Where the daemon writes the Worker's own id — the handle its work adopts. */
export const RED_AFK_WORKER_ID_PLACEHOLDER = "{{worker_id}}";
/** Where the daemon writes the slot it placed this Worker on. */
export const RED_AFK_SLOT_PLACEHOLDER = "{{slot}}";

export interface ProjectLaunchInput {
  /** The interpreter that runs the bundle — `process.execPath` at the call site. */
  readonly interpreter: string;
  /** The bundle this project's Workers run. */
  readonly bundle: string;
  /**
   * The runner the NEXT Worker uses, as this tick decided it.
   *
   * A directive applied this tick arrives here; the template it produces is the
   * one the next birth reads, and every Worker already running keeps the runner
   * it was born with.
   */
  readonly runner: string;
  /** The Spec/Ticket filter and other run flags a `/afk run` would carry. */
  readonly slotArgs?: readonly string[];
  /** The Worker environment this project passes through, minus the per-slot half. */
  readonly workerEnv: Readonly<Record<string, string>>;
  /** Where per-slot retire files live; no retire file at all when absent. */
  readonly retireDir?: string | null;
  /** Whether this project is asking the next Worker to route one tier down. */
  readonly taskTierDowngrade?: boolean;
  /** The Ticket a reconcile Worker is born for; an ordinary drain when absent. */
  readonly reconcileIssue?: number | null;
}

/**
 * Build the launch this project's NEXT Worker is started with. PURE.
 *
 * Every word here is the project's own: the daemon receives them, substitutes the
 * four facts it owns and starts a process. Two calls a tick apart with different
 * runners produce two different templates, which is how a swap survives a
 * registration that carries one launch at a time.
 */
export function buildProjectLaunchTemplate(input: ProjectLaunchInput): RedskilledLaunchTemplate {
  const argv = [
    input.interpreter,
    input.bundle,
    "run",
    "--once",
    "--runner",
    input.runner,
    ...(input.reconcileIssue == null ? [] : ["--reconcile-issue", String(input.reconcileIssue)]),
    ...(input.slotArgs ?? []),
  ];

  const env: Record<string, string> = { ...input.workerEnv };
  // Re-pinned rather than inherited: the passthrough env may carry an operator's
  // runner from before the directive, and the Worker's detection cascade must
  // read the one this tick decided.
  env.RED_AFK_RUNNER = input.runner;
  env.RED_AFK_SLOT = RED_AFK_SLOT_PLACEHOLDER;
  env.RED_AFK_WORKER_ID = RED_AFK_WORKER_ID_PLACEHOLDER;
  if (input.taskTierDowngrade) env.RED_AFK_TASK_TIER_DOWNGRADE = "1";
  else delete env.RED_AFK_TASK_TIER_DOWNGRADE;
  if (input.retireDir != null && input.retireDir !== "") {
    // Per slot, and named by the placeholder rather than by a number: one
    // template serves every slot, and two Workers can never share a retire file.
    env.RED_AFK_RETIRE_FILE = `${input.retireDir}/afk-supervisor-slot-${RED_AFK_SLOT_PLACEHOLDER}.retire`;
  } else delete env.RED_AFK_RETIRE_FILE;

  return { argv, env };
}
