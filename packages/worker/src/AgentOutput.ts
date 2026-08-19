import { z } from "zod";
import { Output, type OutputObjectDefinition } from "./Output.js";

// ---------------------------------------------------------------------------
// AgentOutput — the worker's NATIVE structured terminal signal (ADR 0082).
//
// This is the cross-repo contract between red-castle (the execution substrate)
// and its consumers (AFK, in red-skills). It replaces the fragile text sentinel
// an agent can forget to emit — the root of the recorded `no-sentinel` failure
// class (#788) — with a schema an agent must emit and that the runner validates.
//
// Rollout is PER RUNNER, claude first: a schema-enabled runner emits + validates
// `AgentOutput`, while runners without native schema support keep the text
// sentinel (`<promise>DONE</promise>`) as their terminal signal. The two COEXIST
// — the schema is added alongside the sentinel, never replacing it wholesale —
// and the sentinel is deprecated runner-by-runner as each gains schema support.
// ---------------------------------------------------------------------------

/** The XML tag a schema-enabled agent wraps its terminal `AgentOutput` JSON in. */
export const AGENT_OUTPUT_TAG = "agent-output";

/**
 * The `AgentOutput` schema — the terminal signal a schema-enabled runner emits
 * and validates. Minimal by design (the maintainer-approved contract, #932):
 *
 * - `success`            — did the attempt achieve its goal?
 * - `summary`            — one-paragraph description of what the attempt did.
 * - `key_changes_made`   — the concrete changes landed (files, behaviours).
 * - `key_learnings`      — durable facts discovered worth carrying forward.
 * - `should_fully_stop`  — the agent believes no further attempt is warranted
 *                          (e.g. blocked, or the goal is fully met).
 */
export const agentOutputSchema = z.object({
  success: z.boolean(),
  summary: z.string(),
  key_changes_made: z.array(z.string()),
  key_learnings: z.array(z.string()),
  should_fully_stop: z.boolean(),
});

/** The validated `AgentOutput` value. */
export type AgentOutput = z.infer<typeof agentOutputSchema>;

/**
 * The `Output.object` definition binding {@link AGENT_OUTPUT_TAG} to
 * {@link agentOutputSchema}, for `run()` callers that opt into single-iteration
 * structured output (`run({ output: agentOutput, maxIterations: 1 })`). AFK
 * itself runs multi-iteration, so it uses {@link extractAgentOutput} as a
 * terminal-signal gate instead — but the shared definition keeps the two paths
 * on one schema.
 */
export const agentOutput: OutputObjectDefinition<AgentOutput> = Output.object({
  tag: AGENT_OUTPUT_TAG,
  schema: agentOutputSchema,
});

/** The outcome of extracting `AgentOutput` from agent stdout. */
export type AgentOutputExtraction =
  | { readonly ok: true; readonly value: AgentOutput }
  | {
      readonly ok: false;
      readonly reason: "missing" | "invalid-json" | "schema";
      readonly detail?: string;
    };

/**
 * Find and validate the **last** `<agent-output>...</agent-output>` block in the
 * agent's stdout. Synchronous and self-contained (no `ExtractionContext`), so a
 * consumer can use it as a terminal-signal gate on a multi-iteration run without
 * threading commit/branch context through.
 *
 * - `missing`      — the tag was never emitted.
 * - `invalid-json` — the tag body did not parse as JSON.
 * - `schema`       — the parsed value failed {@link agentOutputSchema}.
 *
 * Fence-aware: a body wrapped in a ```` ```json ```` / ```` ``` ```` Markdown
 * fence is unwrapped before parsing, mirroring {@link extractStructuredOutput}.
 */
export function extractAgentOutput(stdout: string): AgentOutputExtraction {
  const raw = findLastTagContent(stdout, AGENT_OUTPUT_TAG);
  if (raw === undefined) return { ok: false, reason: "missing" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapFences(raw.trim()));
  } catch (cause) {
    return {
      ok: false,
      reason: "invalid-json",
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }

  const result = agentOutputSchema.safeParse(parsed);
  if (!result.success)
    return { ok: false, reason: "schema", detail: result.error.message };
  return { ok: true, value: result.data };
}

// ---------------------------------------------------------------------------
// Tag extraction — last match wins (mirrors extractStructuredOutput's private
// helpers; duplicated here so the terminal-signal gate stays decoupled from the
// run()-oriented extractor).
// ---------------------------------------------------------------------------

function findLastTagContent(text: string, tag: string): string | undefined {
  const openTag = `<${tag}>`;
  const closeTag = `</${tag}>`;

  let lastContent: string | undefined;
  let searchFrom = 0;

  while (true) {
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

function unwrapFences(text: string): string {
  const fenceMatch = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/);
  if (fenceMatch) return fenceMatch[1]!.trim();
  return text;
}
