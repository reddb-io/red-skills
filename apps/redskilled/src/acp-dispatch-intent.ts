/** Exact governed intent retained by redskilled across Workflow Worker replacement. */
export type AcpWorkerKind = "afk" | "go" | "scout";

/** The isolated lane every `go` dispatch selects — never `ready-for-agent`. */
export const GO_DISPATCH_LANE = "lane:go";

/** The isolated lane every read-only `scout` dispatch selects. */
export const SCOUT_DISPATCH_LANE = "lane:scout";

export interface AcpTargetedDispatchIntent {
  readonly version: 1;
  readonly workerKind: AcpWorkerKind;
  readonly ticket: number;
  readonly selector: {
    readonly kind: "issues";
    readonly numbers: readonly number[];
    readonly lane: string;
  };
}

export interface AcpSessionJournal {
  dispatch?: AcpTargetedDispatchIntent;
}

export function createAcpSessionJournal(): AcpSessionJournal {
  return {};
}

/**
 * Bind the first targeted dispatch to the public session and require later
 * turns to name the same governed intent. A replacement consumes this journal;
 * it never reconstructs a selector from a queue or from Worker-local state.
 */
export function bindTargetedDispatch(
  journal: AcpSessionJournal,
  meta: unknown,
): AcpTargetedDispatchIntent | undefined {
  const candidate = dispatchCandidate(meta);
  if (candidate === undefined) return journal.dispatch;
  const dispatch = validateTargetedDispatch(candidate);
  if (journal.dispatch != null && !sameDispatch(journal.dispatch, dispatch)) {
    throw new Error("this ACP session is already bound to a different targeted dispatch");
  }
  journal.dispatch ??= dispatch;
  return journal.dispatch;
}

function dispatchCandidate(meta: unknown): unknown {
  if (!isRecord(meta)) return undefined;
  const redskills = meta.redskills;
  return isRecord(redskills) ? redskills.dispatch : undefined;
}

function validateTargetedDispatch(value: unknown): AcpTargetedDispatchIntent {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("a targeted ACP dispatch must declare version 1");
  }
  const workerKind = value.workerKind;
  if (workerKind !== "afk" && workerKind !== "go" && workerKind !== "scout") {
    throw new Error("a targeted ACP dispatch must declare Worker kind afk, go, or scout");
  }
  const ticket = value.ticket;
  if (!Number.isInteger(ticket) || Number(ticket) <= 0) {
    throw new Error("a targeted ACP dispatch requires a positive Ticket number");
  }
  const selector = value.selector;
  if (!isRecord(selector) || selector.kind !== "issues") {
    throw new Error("a targeted ACP dispatch requires an issues selector");
  }
  const numbers = selector.numbers;
  if (!Array.isArray(numbers) || numbers.length !== 1 || numbers[0] !== ticket) {
    throw new Error("a targeted ACP dispatch selector must name exactly its Ticket");
  }
  const lane = typeof selector.lane === "string" ? selector.lane.trim() : "";
  if (lane === "") throw new Error("a targeted ACP dispatch requires an explicit selector lane");
  const requiredLane = workerKind === "go"
    ? GO_DISPATCH_LANE
    : workerKind === "scout" ? SCOUT_DISPATCH_LANE : undefined;
  if (requiredLane != null && lane !== requiredLane) {
    throw new Error(`Worker kind ${workerKind} requires selector lane ${requiredLane}`);
  }
  return {
    version: 1,
    workerKind,
    ticket: Number(ticket),
    selector: { kind: "issues", numbers: [Number(ticket)], lane },
  };
}

function sameDispatch(left: AcpTargetedDispatchIntent, right: AcpTargetedDispatchIntent): boolean {
  return left.workerKind === right.workerKind &&
    left.ticket === right.ticket &&
    left.selector.kind === right.selector.kind &&
    left.selector.lane === right.selector.lane &&
    left.selector.numbers.length === right.selector.numbers.length &&
    left.selector.numbers.every((number, index) => number === right.selector.numbers[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
