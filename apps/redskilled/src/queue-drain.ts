/**
 * queue-drain — a project whose queue has run out leaves the daemon's list.
 *
 * ADR 0130 Amendment 3: **the list of active projects lives in the daemon and
 * leaves it when the issues run out.** A registration whose selector matches
 * nothing is a query re-asked every window to re-learn a fact that has not
 * changed — the standing cost the batched poll exists to remove, and the one
 * shape of it batching alone cannot remove.
 *
 * **Only a counted zero drains a project.** The three outcomes a queue read can
 * have are three different facts, and exactly one of them is an empty queue: a
 * spent quota and a selector the token could not resolve each carry no depth at
 * all, so a project behind either stays registered and is asked again. Treating
 * them as zeros would retire a project that still had work — the reason this
 * slice lands after the three-outcome one rather than beside it.
 *
 * **A project this poll never asked about is held, not judged.** A registration
 * that arrived mid-flight is absent from an answer that never named it, and
 * absence is not emptiness.
 *
 * **A live Worker is remaining work.** A project whose last item is being worked
 * right now reads zero while the Worker still runs, so a project holding one is
 * kept: deregistering it would drop the registration out from under the process
 * it was made for, and the empty read repeats one window after the Worker dies.
 *
 * **Nothing here reads a selector.** The decision turns on an outcome, an integer
 * and a project label — the daemon still does not know what an Issue is (rule 3).
 *
 * PURE: every input is passed in, the clock included.
 */

import type { RedskilledQueueDiscovery } from "./queue-discovery.js";

/** What the daemon decided about one registered project, and why. */
export interface RedskilledDrainDecision {
  readonly project_label: string;
  readonly deregistered: boolean;
  readonly reason: string;
}

export interface RedskilledQueueDrain {
  readonly version: 1;
  readonly decided_at: string;
  /** The projects to release, by label, ordered — a caller applies them verbatim. */
  readonly deregistered: readonly string[];
  /** One decision per registered project, held ones included, ordered by label. */
  readonly decisions: readonly RedskilledDrainDecision[];
}

export interface PlanQueueDrainInput {
  /** The poll that just answered; `null` before the first one, which drains nothing. */
  readonly discovery: RedskilledQueueDiscovery | null;
  /** The projects the daemon holds a registration for right now. */
  readonly registered: readonly string[];
  /** The projects with a Worker alive; theirs is work a zero cannot see. */
  readonly busyProjects?: readonly string[];
  /** The daemon's own clock, so the decision is dated by the daemon that made it. */
  readonly now: string;
}

/**
 * Decide which registered projects have drained. PURE.
 *
 * The registered set is the subject rather than the answer's project list, so a
 * project the poll skipped is still accounted for — held, with the reason it was
 * held — instead of quietly falling out of a document that claims to cover the
 * whole list.
 */
export function planQueueDrain(input: PlanQueueDrainInput): RedskilledQueueDrain {
  const counted = new Map((input.discovery?.projects ?? []).map((project) => [project.project_label, project]));
  const busy = new Set(input.busyProjects ?? []);
  const decisions = [...input.registered]
    .sort((left, right) => left.localeCompare(right))
    .map((projectLabel): RedskilledDrainDecision => decide(projectLabel, counted.get(projectLabel), busy));

  return {
    version: 1,
    decided_at: input.now,
    deregistered: decisions.filter((decision) => decision.deregistered).map((decision) => decision.project_label),
    decisions,
  };
}

function decide(
  projectLabel: string,
  read: RedskilledQueueDiscovery["projects"][number] | undefined,
  busy: ReadonlySet<string>,
): RedskilledDrainDecision {
  const held = (reason: string): RedskilledDrainDecision => ({ project_label: projectLabel, deregistered: false, reason });
  const named = JSON.stringify(projectLabel);

  if (read == null) {
    return held(`this poll never asked about project ${named}, and an absent answer is not an empty queue`);
  }
  if (read.outcome === "rate-limited") {
    return held(
      `the host token's quota was spent before project ${named} answered, so this queue has no depth rather than a ` +
        `depth of zero and the registration stands`,
    );
  }
  if (read.outcome !== "counted" || read.depth == null) {
    return held(
      `project ${named} could not be reached with the host token, so it carries no depth to drain on and stays ` +
        `registered until one answers`,
    );
  }
  if (read.depth > 0) {
    return held(`project ${named} still has ${read.depth} item(s) matching its selector`);
  }
  if (busy.has(projectLabel)) {
    return held(
      `project ${named} counted zero while a Worker of its own is still alive, and that Worker is the work the count ` +
        `cannot see`,
    );
  }
  return {
    project_label: projectLabel,
    deregistered: true,
    reason:
      `project ${named} counted zero items with the host token answering, so its queue has genuinely drained and the ` +
      `daemon stops polling a selector that names no work`,
  };
}
