// core/comment-respond-extract.ts — the structured-output half of `/dev explain`
// (issue #750). Drives the agent through the vendored sandcastle `run()` +
// `Output.object`, returning the validated answer text the responder posts back
// in-thread. Mirrors review-extract.ts so the heavy `@reddb-io/worker`
// import (and a live agent run) is confined to the production wiring and the
// pure responder routing (comment-respond.ts) stays test-stubbable.

import type { RunOptions, RunResult } from "@reddb-io/worker";
import { resolveMaxRetries, type StandardSchemaLike } from "./review.js";
import type { CommentEvent } from "./comment-respond.js";
import type { DevDirective } from "./comment-classification.js";
import type { AgentRunner, AgentEffort } from "./execution.js";

/** The XML tag the agent must emit its JSON answer inside. */
export const EXPLAIN_OUTPUT_TAG = "output";

/** The structured answer `/dev explain` extracts. */
export interface ExplainAnswer {
  readonly answer: string;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** Standard Schema validator for {@link ExplainAnswer}, used by `Output.object`. */
export const explainAnswerSchema: StandardSchemaLike<ExplainAnswer> = {
  "~standard": {
    version: 1,
    vendor: "red-dev-respond",
    validate: (value: unknown) => {
      try {
        const record = asRecord(value, "explain output");
        const answer = record.answer;
        if (typeof answer !== "string" || answer.trim().length === 0) {
          throw new Error("answer must be a non-empty string");
        }
        return { value: { answer } };
      } catch (error) {
        return { issues: [{ message: error instanceof Error ? error.message : "Validation failed" }] };
      }
    },
  },
};

/** The sandcastle surface the explainer needs, injected so the package import
 * (and a live agent run) is confined to production wiring; tests stub it. */
export interface ExplainExtractDeps {
  run: (options: RunOptions) => Promise<RunResult & { output: ExplainAnswer }>;
  agentFor: (runner: AgentRunner, model: string, opts?: { effort?: AgentEffort }) => RunOptions["agent"];
  sandboxFor: (mode: "none") => RunOptions["sandbox"];
  output: (opts: { tag: string; maxRetries: number }) => RunOptions["output"];
  cwd: string;
}

/**
 * Render the explain prompt. Must contain the `<output>` open tag — `run()`
 * rejects at entry when the configured output tag is absent from the prompt.
 */
export function buildExplainPrompt(event: CommentEvent, directive: DevDirective): string {
  const subject = event.isPr ? `pull request #${event.number}` : `issue #${event.number}`;
  const question = directive.args.trim() || "Explain the change / the discussion in this thread.";
  return [
    `You are an advisory engineering assistant answering a maintainer's question on ${subject}.`,
    "Answer concisely and accurately. You may read the repository to ground your answer.",
    "Do NOT modify any files — this is a read-only, advisory reply.",
    "",
    "The maintainer asked:",
    question,
    "",
    "Reply with your answer as JSON inside a single <output></output> tag, shaped:",
    '<output>{ "answer": "…markdown answer…" }</output>',
  ].join("\n");
}

export interface ExplainModel {
  readonly model: string;
  readonly effort?: AgentEffort;
}

/**
 * Build the `explain` port for the responder. Resolves the structured-output
 * retry budget for the runner (resumable providers re-prompt; the OpenCode/
 * MiniMax lane is single-attempt) and drives `run()` + `Output.object`,
 * returning the validated answer string.
 */
export function makeExplain(
  deps: ExplainExtractDeps,
  model: ExplainModel,
): (event: CommentEvent, directive: DevDirective) => Promise<string> {
  return async (event, directive) => {
    const maxRetries = resolveMaxRetries(event.runner);
    const result = await deps.run({
      cwd: deps.cwd,
      prompt: buildExplainPrompt(event, directive),
      maxIterations: 1,
      agent: deps.agentFor(event.runner, model.model, model.effort ? { effort: model.effort } : undefined),
      sandbox: deps.sandboxFor("none"),
      branchStrategy: { type: "head" },
      logging: { type: "stdout" },
      output: deps.output({ tag: EXPLAIN_OUTPUT_TAG, maxRetries }),
    });
    return result.output.answer;
  };
}
