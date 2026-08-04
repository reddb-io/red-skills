/**
 * One callable cure carried by a castle refusal or empty state (ADR 0134).
 *
 * The same value is published as structured data and rendered into prose by
 * {@link composeRepair}; callers cannot provide an independent human sentence
 * that could name a different mechanism.
 */
export type RepairArgument =
  | null
  | string
  | number
  | boolean
  | readonly RepairArgument[]
  | { readonly [key: string]: RepairArgument };

export interface RepairAction {
  readonly tool: string;
  readonly args: Readonly<Record<string, RepairArgument>>;
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
  return Object.freeze({ none: true, reason });
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
export function externalApprovalRepair(issue: number | string = "<issue-number>"): RepairAction {
  return {
    tool: "gh",
    args: {
      commands: [
        ["issue", "edit", String(issue), "--add-label", "origin:external"],
        ["issue", "comment", String(issue), "--body", "/approve-external"],
      ],
      required_actor: "maintainer",
    },
    why: "mark the issue as external and record explicit approval from a maintainer with write access",
  };
}

/** Copy one JSON value into an immutable representation used by both outputs. */
function normalizeRepairArgument(value: RepairArgument, seen: Set<object>): RepairArgument {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("repair args must contain only finite JSON numbers");
    return value;
  }
  if (seen.has(value)) throw new TypeError("repair args must not contain cycles");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(value.map((item) => normalizeRepairArgument(item, seen)));
    }
    const normalized: Record<string, RepairArgument> = {};
    for (const [key, item] of Object.entries(value)) {
      normalized[key] = normalizeRepairArgument(item, seen);
    }
    return Object.freeze(normalized);
  } finally {
    seen.delete(value);
  }
}

function normalizeRepairAction(repair: RepairAction): RepairAction {
  const args = normalizeRepairArgument(repair.args, new Set());
  return Object.freeze({
    tool: repair.tool,
    args: args as Readonly<Record<string, RepairArgument>>,
    why: repair.why,
  });
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

  const repair = normalizeRepairAction(input.repair);

  return {
    prose:
      `${input.state}; repair: call \`${repair.tool}\` with ` +
      `\`${JSON.stringify(repair.args)}\` because ${repair.why}`,
    repair,
  };
}
