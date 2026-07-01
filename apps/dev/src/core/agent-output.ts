// Structured-output completion adapter (ADR 0082). The AFK worker's canonical
// completion signal has been the free-text `<promise>DONE</promise>` sentinel an
// agent must remember to print verbatim (ADR 0028) — the root of the recorded
// `no-sentinel` / DONE-without-commit failure class (#788). This module adds the
// `AgentOutput` schema as a **parallel, schema-validated completion channel**
// that coexists with the sentinel: a run that emits a valid `<agent-output>`
// block carries a machine-readable end-state the orchestrator can trust, while a
// run that only emits the sentinel keeps working exactly as before.
//
// Rollout is per-runner, claude first (#919/#932): only the claude runner
// registers the block's closing tag as a red-castle completion signal, so a
// claude turn can terminate on the structured block ALONE — curing the
// no-sentinel class for it — while every other runner stays on the sentinel.
import { z } from "zod";

/** The XML tag the agent wraps its structured completion payload in. */
export const AGENT_OUTPUT_TAG = "agent-output";
export const AGENT_OUTPUT_OPEN = `<${AGENT_OUTPUT_TAG}>`;
export const AGENT_OUTPUT_CLOSE = `</${AGENT_OUTPUT_TAG}>`;

/**
 * The structured-output completion schema (ADR 0082 §1). Enforced natively by
 * the claude runner during rollout; the two booleans carry the control-flow
 * semantics the sentinel encodes today, the three text fields are net-new signal
 * for the PR body / audit trail / memory ingestion.
 */
export const AgentOutputSchema = z.object({
  /** Did the attempt achieve its goal? `true` → done, `false` → blocked. */
  success: z.boolean(),
  /** One-paragraph human-readable outcome (feeds the PR body / audit trail). */
  summary: z.string(),
  /** What changed, for the PR body / audit trail. */
  key_changes_made: z.array(z.string()),
  /** Gotchas worth persisting (feeds memory / wiki). */
  key_learnings: z.array(z.string()),
  /** Outer-loop signal: drain no further issues when `true`. */
  should_fully_stop: z.boolean(),
});

export type AgentOutput = z.infer<typeof AgentOutputSchema>;

/**
 * Extract and validate the structured `AgentOutput` completion from an agent's
 * stdout. Mirrors red-castle's structured-output extraction (ADR 0010): the
 * **last** `<agent-output>…</agent-output>` pair wins (self-correction is
 * benign), the contents are unwrapped from an optional Markdown fence, then
 * `JSON.parse`d and validated against {@link AgentOutputSchema}.
 *
 * Returns `undefined` — never throws — on a missing tag, invalid JSON, or a
 * schema mismatch, so the caller falls through to the text-sentinel path (the
 * coexistence guarantee: structured wins, sentinel is the fallback).
 */
export function parseAgentOutput(stdout: string): AgentOutput | undefined {
  const raw = findLastTagContent(stdout, AGENT_OUTPUT_TAG);
  if (raw === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapFences(raw.trim()));
  } catch {
    return undefined;
  }

  const result = AgentOutputSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

/** Find the content between the **last** `<tag>`/`</tag>` pair, or `undefined`. */
function findLastTagContent(text: string, tag: string): string | undefined {
  const openTag = `<${tag}>`;
  const closeTag = `</${tag}>`;
  let lastContent: string | undefined;
  let searchFrom = 0;
  for (;;) {
    const openIdx = text.indexOf(openTag, searchFrom);
    if (openIdx === -1) break;
    const contentStart = openIdx + openTag.length;
    const closeIdx = text.indexOf(closeTag, contentStart);
    if (closeIdx === -1) break;
    lastContent = text.slice(contentStart, closeIdx);
    searchFrom = closeIdx + closeTag.length;
  }
  return lastContent;
}

/** Strip an optional ```` ```json … ``` ```` (or bare ```` ``` … ``` ````) fence. */
function unwrapFences(text: string): string {
  const fenceMatch = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/);
  return fenceMatch ? fenceMatch[1]!.trim() : text;
}
