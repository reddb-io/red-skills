export const OUTCOME_EVENT_SCHEMA_VERSION = 1 as const;

export type OutcomeEventOutcome = "success" | "failure" | "escalated";

export type OutcomeEventCostSignal = "none" | "low" | "medium" | "high" | "unknown";

export interface OutcomeEventChosenOption {
  kind: string;
  runner?: string;
  model?: string;
  effort?: string;
}

export interface OutcomeEventCost {
  signal: OutcomeEventCostSignal;
  totalUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface OutcomeEventContext {
  repository?: string;
  issueNumber?: number;
  attemptNumber?: number;
  issueType?: string;
  workerId?: string;
  branch?: string;
  durationMs?: number;
  status?: string;
}

export interface OutcomeEventV1 {
  schemaVersion: typeof OUTCOME_EVENT_SCHEMA_VERSION;
  id: string;
  emitter: string;
  occurredAt: string;
  taskClass: string;
  chosenOption: OutcomeEventChosenOption;
  outcome: OutcomeEventOutcome;
  cost: OutcomeEventCost;
  context?: OutcomeEventContext;
}

export type OutcomeEvent = OutcomeEventV1;

export function isOutcomeEvent(value: unknown): value is OutcomeEvent {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.schemaVersion === OUTCOME_EVENT_SCHEMA_VERSION &&
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.emitter === "string" &&
    candidate.emitter.length > 0 &&
    typeof candidate.occurredAt === "string" &&
    typeof candidate.taskClass === "string" &&
    isChosenOption(candidate.chosenOption) &&
    isOutcome(candidate.outcome) &&
    isCost(candidate.cost)
  );
}

function isChosenOption(value: unknown): value is OutcomeEventChosenOption {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.kind === "string" && candidate.kind.length > 0;
}

function isOutcome(value: unknown): value is OutcomeEventOutcome {
  return value === "success" || value === "failure" || value === "escalated";
}

function isCost(value: unknown): value is OutcomeEventCost {
  if (typeof value !== "object" || value === null) return false;
  const signal = (value as Record<string, unknown>).signal;
  return signal === "none" || signal === "low" || signal === "medium" || signal === "high" || signal === "unknown";
}
