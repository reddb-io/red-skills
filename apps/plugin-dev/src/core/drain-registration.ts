// drain-registration — what `drain` hands the daemon so a drain drains (#4101).
//
// **The MCP authors the semantics; the daemon carries them.** ADR 0130
// Amendment 4 splits the lane there, and the thin MCP (ADR 0147 §2) is exactly
// the surface that understands what an Issue, a label and a ready lane are.
// The daemon receives a query string, a typed poll plan, an argv and a prompt,
// stores them and hands them back — it never learns what any of them say.
//
// This is the piece nobody reconnected after the dev CLI was deleted: the
// registration used to be authored by the engine that #4031 removed, so every
// drain since recorded an intention the demand loop had nothing to poll for.
//
// PURE — strings in, one record out, no daemon, no filesystem, no process.
import { canonicalInvocation } from "@reddb-io/shared/canonical-invocation.js";

import {
  buildRegistrationPollPlan,
  buildRegistrationQuery,
  type RegistrationPollPlan,
  type RegistrationQuerySelector,
} from "./registration-query.js";

export interface DrainRegistrationInput {
  /** The trunk branch this checkout lands against; `main` when unstated. */
  readonly trunkBranch?: string | undefined;
  /** The declared local gate commands; absent means the repo declared none. */
  readonly validationCommands?: readonly string[] | undefined;
  /** `owner/name` — the repository whose tracker holds this project's queue. */
  readonly repo: string;
  /** Where a Worker for this project runs; the project's own checkout. */
  readonly workspacePath: string;
  readonly target: number;
  readonly selector?: RegistrationQuerySelector | undefined;
  /** The coder Agent a Worker runs, named by the caller. */
  readonly runner?: string | undefined;
  /** The published version whose binary a birth reaches for (ADR 0091). */
  readonly version: string;
  /** The label that defines "queued"; the executable lane's own by default. */
  readonly readyLabel?: string | undefined;
  /** The operator's declared wall-clock budget for this drain; absent = none. */
  readonly budgetMs?: number | undefined;
}

export interface DrainRegistration {
  readonly selector: string;
  readonly queue_poll: RegistrationPollPlan;
  readonly argv: readonly string[];
  readonly workspace_path: string;
  /**
   * The trunk a Worker's Ticket is measured and landed against.
   *
   * **A registration without a trunk drains nothing**: the daemon states the
   * Ticket handoff only when every fact it requires is present, and `base` is
   * one of them — so a drain that omitted the trunk birthed Workers that were
   * never briefed and idled. That was the hand-written mistake of the first
   * live drain, and the product path repeated it.
   */
  readonly trunk: { readonly remote: string; readonly branch: string };
  readonly prompt: string;
  /**
   * The repo's DECLARED local gate, handed to every Worker (#4166). Without
   * it the Worker improvises a full workspace suite — contradicting the
   * "sole local validation authority" contract and flaking under the Worker
   * memory ceiling, a different package red each round.
   */
  readonly validation_commands?: readonly string[];
  /**
   * The operator's declared drain budget, in milliseconds (#4170).
   *
   * **Absent is the ordinary case and means no harvest deadline at all.** The
   * daemon arms the deadline off this number and off nothing else, so a drain
   * that states none runs exactly as every drain ran before it — the daemon
   * never invents a budget an operator did not ask for.
   */
  readonly budget_ms?: number;
  readonly target: number;
}

/**
 * What a Worker born for this project is told to do.
 *
 * The inner agent's whole job is the CHANGE: the Worker body has already
 * claimed the Ticket through the daemon before the agent speaks, and the same
 * body runs the gate, publishes the commits and lands the PR after it stops.
 * The old prompt restated the v3 whole-pipeline verbs ("claim it, open the PR,
 * land it") — so a well-behaved agent tried the GitHub claim mutation itself,
 * the unattended turn refused the permission by design, and the agent obeyed
 * "if you cannot claim it, stop": every turn ended honest and empty. The
 * prompt now tells the truth about the division of labour.
 * `{{work_item}}` is the daemon's fact, written in at birth (#4099).
 */
export const DRAIN_WORKER_PROMPT =
  "Implement issue #{{work_item}} in this workspace. The Ticket is already claimed for you, and " +
  "the daemon runs the gate, publishes your commits and lands the pull request after you finish — " +
  "so never touch GitHub yourself: no label moves, no claim or status comments, no PR. Your whole " +
  "job is the change and its commits, right here. " +
  // #4162: an inner agent reading the repository's interactive-mode rules built
  // a NESTED worktree under .red/tmp/worktrees/manual inside its own worktree.
  // The Worker's workspace was already materialised by the daemon on the
  // Ticket's base, so the prompt says so — the worktree rules it would
  // otherwise follow govern a human's checkout, not a Worker.
  "You are already standing in your own dedicated worktree on the Ticket's base branch: work and " +
  "commit right here, and never create another worktree — the repository's worktree lanes govern " +
  "interactive sessions, not Workers. " +
  // The repo's scope gate refuses a PR that changes apps/ or packages/ without
  // a changeset, and the first autonomous PR died exactly there (#4243).
  "If your change touches apps/ or packages/, also write a .changeset/<slug>.md entry naming each " +
  "touched package by its package.json name with a patch bump, and commit it with the change. " +
  "When the change is committed, say <promise>DONE</promise>. If the work is genuinely blocked, " +
  "say what blocks it and <promise>BLOCKED</promise>.";

/** Build the registration a drain carries. PURE. */
export function buildDrainRegistration(input: DrainRegistrationInput): DrainRegistration {
  const queryInput = {
    repo: input.repo,
    ...(input.selector == null ? {} : { selector: input.selector }),
    ...(input.readyLabel == null ? {} : { readyLabel: input.readyLabel }),
  };
  return {
    selector: buildRegistrationQuery(queryInput),
    queue_poll: buildRegistrationPollPlan(queryInput),
    // The argv still has to name something runnable: a prompt-driven birth is
    // served by the daemon's own Worker, but the registration shape predates
    // that and a placeholder nobody could run would be a lie the probe in
    // #4103 is about to catch.
    argv: canonicalInvocation(
      "red-skills-redskilled",
      ["acp-worker", ...(input.runner == null ? [] : ["--child-agent", input.runner])],
      input.version,
    ).split(" "),
    workspace_path: input.workspacePath,
    trunk: { remote: "origin", branch: input.trunkBranch ?? "main" },
    prompt: DRAIN_WORKER_PROMPT,
    ...(input.validationCommands == null || input.validationCommands.length === 0
      ? {}
      : { validation_commands: [...input.validationCommands] }),
    ...(input.budgetMs == null ? {} : { budget_ms: input.budgetMs }),
    target: input.target,
  };
}
