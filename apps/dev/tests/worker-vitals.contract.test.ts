import { describe, expect, it } from "vitest";
import type { AgentStreamEvent } from "../src/core/execution.js";
import { AfkCurrentSchema, type WorkerVitals } from "../src/types/state.js";

// The contract test (ADR 0065): pin the red-castle stream-event type -> canonical
// WorkerVitals field map so a future per-CLI parser change cannot silently
// reintroduce name drift across the chain. This guards TWO directions at once:
//
//  1. COMPLETENESS (compile-time): the `satisfies Record<AgentStreamEvent["type"],
//     ...>` makes TypeScript fail to compile if red-castle adds a new
//     AgentStreamEvent variant without an entry here.
//  2. VALIDITY (compile-time): each mapped target is `keyof WorkerVitals`, so a
//     typo or a renamed vital that no longer exists fails to compile.
//  3. PERSISTENCE (runtime): every mapped field is actually present on the parsed
//     `current.*`, i.e. the schema persists it (the lesson from S1/PR #705 —
//     undeclared keys are stripped by updateState's schema round-trip).
const EVENT_TO_VITALS = {
  text: ["text_chunk_count"],
  toolCall: ["tools_called_count"],
  reasoning: ["reasoning_events", "reasoning_tokens"],
  usage: ["input_tokens", "output_tokens", "cost_usd"],
  // Terminal result text is logged as a discrete event, but it is not a
  // cumulative WorkerVitals counter.
  result: [],
  // Session id metadata is firehose-only diagnostics, not worker activity.
  sessionId: [],
  // `raw` (sandcastle 0.11.0 verbose stdout stream) is firehose-only diagnostics,
  // not an assistant turn — it maps to no WorkerVitals field.
  raw: [],
} satisfies Record<AgentStreamEvent["type"], (keyof WorkerVitals)[]>;

describe("WorkerVitals contract (ADR 0065)", () => {
  it("maps every red-castle stream-event type to canonical current.* fields that are persisted", () => {
    const current = AfkCurrentSchema.parse({});
    for (const [eventType, fields] of Object.entries(EVENT_TO_VITALS)) {
      for (const field of fields) {
        // The mapped vital must survive a schema round-trip (be persisted),
        // not just exist as a TypeScript key.
        expect(current, `${eventType} -> ${field} must be a persisted current.* field`).toHaveProperty(
          field,
        );
        expect(typeof (current as Record<string, unknown>)[field]).toBe("number");
      }
    }
  });

  it("covers every AgentStreamEvent variant (no unmapped event type)", () => {
    // Runtime mirror of the compile-time `satisfies` completeness check: the set
    // of mapped event types is exactly what we expect. If red-castle adds a
    // variant, the `satisfies` above fails to compile first; this keeps the
    // expectation visible to a human reviewer too.
    expect(Object.keys(EVENT_TO_VITALS).sort()).toEqual([
      "raw",
      "reasoning",
      "result",
      "sessionId",
      "text",
      "toolCall",
      "usage",
    ]);
  });

  it("rejects a map that omits a known event type (compile-time guard demonstrated)", () => {
    // A map missing the `usage` variant must NOT satisfy the Record over
    // AgentStreamEvent["type"]. The @ts-expect-error fails the BUILD if the
    // completeness guard ever stops working (an unused directive is itself an error).
    // prettier-ignore
    // @ts-expect-error missing `usage` key
    const _incomplete: Record<AgentStreamEvent["type"], (keyof WorkerVitals)[]> = { text: ["text_chunk_count"], toolCall: ["tools_called_count"], reasoning: ["reasoning_events"], result: [], sessionId: [], raw: [] };
    void _incomplete;
    expect(true).toBe(true);
  });

  it("rejects a map pointing at a non-vital field (compile-time guard demonstrated)", () => {
    // `thinking_called_count` was renamed to reasoning_events, so it is no longer
    // a keyof WorkerVitals — pointing a mapping at it must fail to compile.
    // prettier-ignore
    // @ts-expect-error `thinking_called_count` is not a keyof WorkerVitals
    const _wrongField: Record<AgentStreamEvent["type"], (keyof WorkerVitals)[]> = { text: ["text_chunk_count"], toolCall: ["tools_called_count"], reasoning: ["reasoning_events", "reasoning_tokens"], usage: ["thinking_called_count"], result: [], sessionId: [], raw: [] };
    void _wrongField;
    expect(true).toBe(true);
  });
});
