export const SPIN_THRESHOLDS = {
  repeatedActionObservationPairs: 3,
  errorStreakPairs: 3,
  monologueMessages: 6,
  alternatingPingPongCycles: 3,
} as const;

export type NormalizedRunnerStreamEvent =
  | { readonly kind: "action"; readonly content: string }
  | { readonly kind: "observation"; readonly content: string }
  | { readonly kind: "error"; readonly content: string }
  | { readonly kind: "message"; readonly content: string };

export type SpinPattern =
  | "repeated-action-observation"
  | "error-streak"
  | "monologue"
  | "alternating-ping-pong";

export interface SpinVerdict {
  readonly pattern: SpinPattern;
}

const ISO_TIMESTAMP =
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\b/gi;
const PROCESS_ID = /\b(?:pid|process\s+id)\s*[:=#]?\s*\d+\b/gi;
const HEX_ADDRESS = /\b0x[0-9a-f]+\b/gi;
const IPV4_ADDRESS = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g;

function semanticContent(content: string): string {
  return content
    .replace(ISO_TIMESTAMP, "<timestamp>")
    .replace(PROCESS_ID, "<pid>")
    .replace(HEX_ADDRESS, "<address>")
    .replace(IPV4_ADDRESS, "<address>");
}

function sameContent(left: string, right: string): boolean {
  return semanticContent(left) === semanticContent(right);
}

export function evaluateSpin(
  events: readonly NormalizedRunnerStreamEvent[],
): SpinVerdict | null {
  const monologueTail = events.slice(-SPIN_THRESHOLDS.monologueMessages);
  if (
    monologueTail.length === SPIN_THRESHOLDS.monologueMessages &&
    monologueTail.every((event) => event.kind === "message")
  ) {
    return { pattern: "monologue" };
  }

  const pingPongEventCount = SPIN_THRESHOLDS.alternatingPingPongCycles * 4;
  const pingPongTail = events.slice(-pingPongEventCount);
  const [actionA, observationA, actionB, observationB] = pingPongTail;
  if (
    pingPongTail.length === pingPongEventCount &&
    actionA?.kind === "action" &&
    observationA?.kind === "observation" &&
    actionB?.kind === "action" &&
    observationB?.kind === "observation" &&
    (!sameContent(actionA.content, actionB.content) ||
      !sameContent(observationA.content, observationB.content))
  ) {
    let alternating = true;
    for (let index = 0; index < pingPongTail.length; index += 4) {
      const cycle = pingPongTail.slice(index, index + 4);
      if (
        cycle[0]?.kind !== "action" ||
        !sameContent(cycle[0].content, actionA.content) ||
        cycle[1]?.kind !== "observation" ||
        !sameContent(cycle[1].content, observationA.content) ||
        cycle[2]?.kind !== "action" ||
        !sameContent(cycle[2].content, actionB.content) ||
        cycle[3]?.kind !== "observation" ||
        !sameContent(cycle[3].content, observationB.content)
      ) {
        alternating = false;
        break;
      }
    }
    if (alternating) return { pattern: "alternating-ping-pong" };
  }

  const errorPairCount = SPIN_THRESHOLDS.errorStreakPairs;
  const errorTail = events.slice(-errorPairCount * 2);
  const firstErrorAction = errorTail[0];
  if (
    errorTail.length === errorPairCount * 2 &&
    firstErrorAction?.kind === "action"
  ) {
    let errorStreak = true;
    for (let index = 0; index < errorTail.length; index += 2) {
      const action = errorTail[index];
      const error = errorTail[index + 1];
      if (
        action?.kind !== "action" ||
        error?.kind !== "error" ||
        !sameContent(action.content, firstErrorAction.content)
      ) {
        errorStreak = false;
        break;
      }
    }
    if (errorStreak) return { pattern: "error-streak" };
  }

  const pairCount = SPIN_THRESHOLDS.repeatedActionObservationPairs;
  const tail = events.slice(-pairCount * 2);
  if (tail.length !== pairCount * 2) return null;

  const [firstAction, firstObservation] = tail;
  if (
    firstAction?.kind !== "action" ||
    firstObservation?.kind !== "observation"
  ) {
    return null;
  }

  for (let index = 0; index < tail.length; index += 2) {
    const action = tail[index];
    const observation = tail[index + 1];
    if (
      action?.kind !== "action" ||
      observation?.kind !== "observation" ||
      !sameContent(action.content, firstAction.content) ||
      !sameContent(observation.content, firstObservation.content)
    ) {
      return null;
    }
  }

  return { pattern: "repeated-action-observation" };
}
