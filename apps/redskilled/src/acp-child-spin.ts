/** Deterministic Spin evaluation owned by a Workflow Worker over child ACP updates. */
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { encode } from "@reddb-io/toon";
import {
  evaluateSpin,
  SPIN_THRESHOLDS,
  type NormalizedRunnerStreamEvent,
  type SpinPattern,
} from "@reddb-io/red-castle/engine/spin-evaluator";

export type ChildSpinObservation =
  | { readonly kind: "detected"; readonly pattern: SpinPattern }
  | { readonly kind: "persistent"; readonly pattern: SpinPattern };

export interface ChildAcpSpinEpisode {
  observe(update: SessionNotification["update"]): ChildSpinObservation | null;
  beginSteer(): SpinPattern | undefined;
  persistWithoutSteer(): SpinPattern | undefined;
  persistentPattern(): SpinPattern | undefined;
}

const MAX_SPIN_WINDOW = Math.max(
  SPIN_THRESHOLDS.monologueMessages,
  SPIN_THRESHOLDS.repeatedActionObservationPairs * 2,
  SPIN_THRESHOLDS.errorStreakPairs * 2,
  SPIN_THRESHOLDS.alternatingPingPongCycles * 4,
);

export function createChildAcpSpinEpisode(): ChildAcpSpinEpisode {
  const events: NormalizedRunnerStreamEvent[] = [];
  const terminalToolCalls = new Set<string>();
  let detected: SpinPattern | undefined;
  let persistent: SpinPattern | undefined;
  let steering = false;
  let lastMessageId: string | null | undefined;

  const record = (event: NormalizedRunnerStreamEvent): ChildSpinObservation | null => {
    if (persistent != null) return null;
    if (detected != null && !steering) return null;
    events.push(event);
    if (events.length > MAX_SPIN_WINDOW) events.shift();
    const verdict = evaluateSpin(events);
    if (verdict == null) return null;
    events.length = 0;
    if (detected == null) {
      detected = verdict.pattern;
      return { kind: "detected", pattern: verdict.pattern };
    }
    persistent ??= verdict.pattern;
    return { kind: "persistent", pattern: persistent };
  };

  return {
    observe(update) {
      for (const event of normalizeChildAcpUpdate(update, terminalToolCalls, lastMessageId)) {
        if (update.sessionUpdate === "agent_message_chunk") lastMessageId = update.messageId;
        const observation = record(event);
        if (observation != null) return observation;
      }
      return null;
    },
    beginSteer() {
      if (detected == null || steering) return undefined;
      steering = true;
      events.length = 0;
      terminalToolCalls.clear();
      lastMessageId = undefined;
      return detected;
    },
    persistWithoutSteer() {
      persistent ??= detected;
      return persistent;
    },
    persistentPattern: () => persistent,
  };
}

function normalizeChildAcpUpdate(
  update: SessionNotification["update"],
  terminalToolCalls: Set<string>,
  lastMessageId: string | null | undefined,
): NormalizedRunnerStreamEvent[] {
  if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
    if (update.messageId != null && update.messageId === lastMessageId) return [];
    return [{ kind: "message", content: update.content.text }];
  }
  if (update.sessionUpdate === "tool_call") {
    const action = {
      kind: "action" as const,
      content: semanticToolValue(update.name ?? update.title, update.rawInput),
    };
    return update.status === "completed" || update.status === "failed"
      ? [action, terminalToolEvent(update.toolCallId, update.status, update.rawOutput, update.content, terminalToolCalls)]
      : [action];
  }
  if (
    update.sessionUpdate === "tool_call_update" &&
    (update.status === "completed" || update.status === "failed") &&
    !terminalToolCalls.has(update.toolCallId)
  ) {
    return [terminalToolEvent(update.toolCallId, update.status, update.rawOutput, update.content, terminalToolCalls)];
  }
  return [];
}

function terminalToolEvent(
  toolCallId: string,
  status: "completed" | "failed",
  rawOutput: unknown,
  content: unknown,
  terminalToolCalls: Set<string>,
): NormalizedRunnerStreamEvent {
  terminalToolCalls.add(toolCallId);
  return {
    kind: status === "failed" ? "error" : "observation",
    content: semanticToolValue(rawOutput, content),
  };
}

function semanticToolValue(primary: unknown, fallback: unknown): string {
  const value = primary ?? fallback ?? "";
  return typeof value === "string" ? value : encode(value);
}
