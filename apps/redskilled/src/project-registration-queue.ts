/** An ETag-capable repository list carried by the daemon without interpretation. */
export interface RedskilledQueuePollPlan {
  readonly owner: string;
  readonly repo: string;
  readonly labels: readonly string[];
  readonly creator?: string;
  readonly counter_labels?: RedskilledCounterLabels;
}

export interface RedskilledCounterLabels {
  readonly ready: string;
  readonly human: string;
}

export function requireQueuePollPlan(
  value: unknown,
  projectLabel: string,
): RedskilledQueuePollPlan | undefined {
  if (value === undefined) return undefined;
  if (!isQueuePollPlanShape(value)) {
    throw new Error(
      `redskilled needs a complete queue poll plan for project ${JSON.stringify(projectLabel)} when one is stated`,
    );
  }
  return value;
}

export function isQueuePollPlanShape(value: unknown): value is RedskilledQueuePollPlan {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const plan = value as Record<string, unknown>;
  const counters = plan.counter_labels as Record<string, unknown> | undefined;
  return typeof plan.owner === "string" && plan.owner !== "" &&
    typeof plan.repo === "string" && plan.repo !== "" &&
    Array.isArray(plan.labels) && plan.labels.length > 0 &&
    plan.labels.every((label) => typeof label === "string" && label !== "") &&
    (plan.creator === undefined || typeof plan.creator === "string") &&
    (counters === undefined || (counters !== null && typeof counters === "object" &&
      typeof counters.ready === "string" && counters.ready !== "" &&
      typeof counters.human === "string" && counters.human !== ""));
}
