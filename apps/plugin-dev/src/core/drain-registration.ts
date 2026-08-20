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
  readonly target: number;
}

/**
 * What a Worker born for this project is told to do.
 *
 * One sentence, because the Worker is a coder Agent carrying the dev skills:
 * the verbs it needs are already its own, and a prompt that restated them would
 * be a second copy of `/afk` maintained here. `{{work_item}}` is the daemon's
 * fact, written in at birth (#4099).
 */
export const DRAIN_WORKER_PROMPT =
  "Work issue #{{work_item}} in this repository to a merged pull request, following the /afk skill: " +
  "claim it, implement it in this workspace, run the gate, open the PR, and land it. " +
  // #4162: an inner agent reading the repository's interactive-mode rules built
  // a NESTED worktree under .red/tmp/worktrees/manual inside its own worktree.
  // The Worker's workspace was already materialised by the daemon on the
  // Ticket's base, so the prompt says so — the worktree rules it would
  // otherwise follow govern a human's checkout, not a Worker.
  "You are already standing in your own dedicated worktree on the Ticket's base branch: work and " +
  "commit right here, and never create another worktree — the repository's worktree lanes govern " +
  "interactive sessions, not Workers. " +
  "If you cannot claim it or the work is blocked, say so plainly and stop.";

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
    target: input.target,
  };
}
