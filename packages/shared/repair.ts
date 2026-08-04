/**
 * One callable cure carried by a castle refusal or empty state (ADR 0134).
 *
 * The same value is published as structured data and rendered into prose by
 * {@link composeRepair}; callers cannot provide an independent human sentence
 * that could name a different mechanism.
 */
export interface RepairAction {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly why: string;
}

/** An argued absence of a safe callable cure. */
export interface NoRepair {
  readonly none: true;
  readonly reason: string;
}

export type RepairSource = RepairAction | NoRepair;

export type ComposedRepair =
  | { readonly prose: string; readonly repair: RepairAction }
  | { readonly prose: string; readonly repair: "none"; readonly repair_reason: string };

/** Declare that this state has no safe callable cure, and say why. */
export function noRepair(reason: string): NoRepair {
  return { none: true, reason };
}

/** The pasteable registration action shared by every unregistered surface. */
export function registrationRepair(): RepairAction {
  return {
    tool: "project_start",
    args: { runner: "claude", target: 1 },
    why: "register this project with the host so its queue can drain",
  };
}

/** The exact two-part approval required by the external-origin trust gate. */
export function externalApprovalRepair(): RepairAction {
  return {
    tool: "github_issue",
    args: {
      add_label: "origin:external",
      comment: "/approve-external",
      comment_author: "maintainer",
    },
    why: "mark the issue as external and record explicit approval from a maintainer with write access",
  };
}

/**
 * Compose structured repair data and its human sentence from one input. PURE.
 *
 * `state` names only what happened. Repair choreography is accepted only in
 * structured form and rendered here, so prose and mechanism cannot diverge.
 */
export function composeRepair(input: {
  readonly state: string;
  readonly repair: RepairSource;
}): ComposedRepair {
  if ("none" in input.repair) {
    return {
      prose: `${input.state}; repair: none because ${input.repair.reason}`,
      repair: "none",
      repair_reason: input.repair.reason,
    };
  }

  return {
    prose:
      `${input.state}; repair: call \`${input.repair.tool}\` with ` +
      `\`${JSON.stringify(input.repair.args)}\` because ${input.repair.why}`,
    repair: input.repair,
  };
}
