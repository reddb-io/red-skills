import { Context, Effect, Layer } from "effect";

/**
 * A single event in the agent's output stream, surfaced to callers of `run()`
 * so they can forward it to their own observability system.
 *
 * Emitted only in log-to-file mode when an `onAgentStreamEvent` callback is
 * provided via `logging`. See `run()`.
 *
 * The `"raw"` variant carries every stdout line the agent emits, verbatim and
 * before parsing — including lines that the provider's stream parser would
 * otherwise drop (e.g. tool-use blocks for unrecognised tools). Intended for
 * debugging when the typed `"text"` / `"toolCall"` events don't surface
 * enough detail.
 */
export type AgentStreamEvent =
  | {
      readonly type: "text";
      readonly message: string;
      readonly iteration: number;
      readonly timestamp: Date;
    }
  | {
      readonly type: "toolCall";
      readonly name: string;
      readonly formattedArgs: string;
      readonly iteration: number;
      readonly timestamp: Date;
    }
  | {
      readonly type: "raw";
      readonly line: string;
      readonly iteration: number;
      readonly timestamp: Date;
    }
  | {
      readonly type: "result";
      readonly result: string;
      readonly iteration: number;
      readonly timestamp: Date;
    }
  | {
      readonly type: "sessionId";
      readonly sessionId: string;
      readonly iteration: number;
      readonly timestamp: Date;
    }
  | {
      // Model reasoning/thinking. `message` is the reasoning text when the runner
      // streams it (claude thinking blocks) or "" when only a token count is
      // available (codex/opencode). `tokens` is the reasoning token count for the
      // turn/step when the runner exposes it, else absent.
      readonly type: "reasoning";
      readonly message: string;
      readonly tokens?: number;
      readonly iteration: number;
      readonly timestamp: Date;
    }
  | {
      // Per-turn/step token usage, forwarded live when the runner streams it
      // (codex `turn.completed`, opencode `step_finish`). Lets consumers track
      // running token spend per worker. Fields mirror IterationUsage; the
      // reasoning/cost fields are absent when the runner does not break them out.
      readonly type: "usage";
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cacheReadInputTokens: number;
      readonly cacheCreationInputTokens: number;
      readonly reasoningTokens?: number;
      readonly costUsd?: number;
      readonly iteration: number;
      readonly timestamp: Date;
    };

export interface AgentStreamEmitterService {
  readonly emit: (event: AgentStreamEvent) => Effect.Effect<void>;
}

export class AgentStreamEmitter extends Context.Tag("AgentStreamEmitter")<
  AgentStreamEmitter,
  AgentStreamEmitterService
>() {}

/**
 * Build a layer for the AgentStreamEmitter service.
 *
 * Called with no argument, returns a no-op layer that discards events.
 * Called with a callback, returns a layer that forwards each event to it.
 * The callback is invoked synchronously inside an `Effect.sync`; any error
 * thrown by the callback is caught and discarded so observability failures
 * cannot kill the run.
 */
export const agentStreamEmitterLayer = (
  onEvent?: (event: AgentStreamEvent) => void,
): Layer.Layer<AgentStreamEmitter> =>
  Layer.succeed(AgentStreamEmitter, {
    emit: onEvent
      ? (event) =>
          Effect.sync(() => {
            try {
              onEvent(event);
            } catch {
              // Swallow callback errors — a broken forwarder must not kill the run.
            }
          })
      : () => Effect.void,
  });
