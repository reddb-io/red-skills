import { Deferred, Duration, Effect, Fiber } from "effect";
import { AgentStreamEmitter } from "./AgentStreamEmitter.js";
import { Display } from "./Display.js";
import { preprocessPrompt } from "./PromptPreprocessor.js";
import {
  AgentError,
  AgentIdleTimeoutError,
  SessionCaptureError,
} from "./errors.js";
import type { SandboxError } from "./errors.js";
import type { SandboxService } from "./SandboxFactory.js";
import { SandboxFactory } from "./SandboxFactory.js";
import { withSandboxLifecycle, type SandboxHooks } from "./SandboxLifecycle.js";
import type { AgentProvider, IterationUsage } from "./AgentProvider.js";
import type { Timeouts } from "./run.js";
import { TextDeltaBuffer } from "./TextDeltaBuffer.js";
import { attachAbortMetadata } from "./AbortMetadata.js";
import { specialUserRequestBlock } from "./engine/runner-spawn.js";

export type { ParsedStreamEvent, IterationUsage } from "./AgentProvider.js";

const IDLE_WARNING_INTERVAL_MS = 60_000;

const invokeAgent = (
  sandbox: SandboxService,
  sandboxRepoDir: string,
  prompt: string,
  provider: AgentProvider,
  idleTimeoutMs: number,
  completionTimeoutMs: number,
  completionSignals: readonly string[],
  onText: (text: string) => void,
  onToolCall: (name: string, formattedArgs: string) => void,
  onRawLine: (line: string) => void,
  onIdleWarning: (minutes: number) => void,
  onCompletionTimeout: (timeoutMs: number) => void,
  idleWarningIntervalMs: number = IDLE_WARNING_INTERVAL_MS,
  resumeSession?: string,
  forkSession?: boolean,
  signal?: AbortSignal,
  // Optional, appended last so existing positional callers are unaffected.
  // `text` is the reasoning text (claude thinking) or "" (codex/opencode, which
  // only expose a token count); `tokens` is the reasoning token count when known.
  onReasoning?: (text: string, tokens?: number) => void,
  // A system/contract prompt delivered per-CLI by the provider (claude
  // --append-system-prompt; codex/opencode prepend). Optional, appended last.
  systemPrompt?: string,
  // Forwards each per-turn/step token-usage snapshot live (codex turn.completed,
  // opencode step_finish) so consumers can track running spend. Optional,
  // appended last so existing positional callers are unaffected.
  onUsage?: (usage: IterationUsage) => void,
  onResult?: (result: string) => void,
  onObservedSessionId?: (sessionId: string) => void,
): Effect.Effect<
  { result: string; sessionId?: string; usage?: IterationUsage },
  SandboxError
> =>
  Effect.gen(function* () {
    let resultText = "";
    let sessionId: string | undefined;
    let usage: IterationUsage | undefined;
    // Accumulated text/result output, scanned for the completion signal so a
    // hanging process can be force-completed once the signal is in the buffer
    // (see ADR 0019).
    let accumulatedOutput = "";

    // Deferred that fails when the idle timer fires (no signal seen).
    const timeoutSignal = yield* Deferred.make<never, AgentIdleTimeoutError>();
    // Deferred that resolves successfully when the completion-grace timer
    // fires (signal seen but process hasn't exited). Resolving lets the race
    // hand control back to the orchestrator with the buffered output, which
    // still contains the signal so the existing completionSignal check works.
    const completionTimeoutDeferred = yield* Deferred.make<
      { result: string; sessionId?: string; usage?: IterationUsage },
      never
    >();
    let timeoutFiber: Fiber.RuntimeFiber<unknown, unknown> | null = null;
    let completionDetected = false;
    // A streamed tool_call is the agent's proof that it handed work to a child
    // process. Agent CLIs do not emit a matching completion event while that
    // child is silent, so keep the text-silence timer renewable until the next
    // parsed agent event demonstrates that control returned.
    let toolCallInFlight = false;

    // Periodic idle warning state
    let warningFiber: Fiber.RuntimeFiber<unknown, unknown> | null = null;
    let idleMinuteCounter = 0;

    const interruptFiber = (
      fiber: Fiber.RuntimeFiber<unknown, unknown> | null,
    ) => {
      if (fiber !== null) Effect.runFork(Fiber.interrupt(fiber));
    };

    const startWarningInterval = () => {
      interruptFiber(warningFiber);
      idleMinuteCounter = 0;
      warningFiber = Effect.runFork(
        Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep(Duration.millis(idleWarningIntervalMs));
            idleMinuteCounter++;
            onIdleWarning(idleMinuteCounter);
          }
        }),
      );
    };

    const armIdleTimer = () => {
      timeoutFiber = Effect.runFork(
        Effect.gen(function* () {
          yield* Effect.sleep(Duration.millis(idleTimeoutMs));
          if (toolCallInFlight) {
            armIdleTimer();
            return;
          }
          yield* Deferred.fail(
            timeoutSignal,
            new AgentIdleTimeoutError({
              message: `Agent idle for ${idleTimeoutMs / 1000} seconds — no output received. Consider increasing the idle timeout with --idle-timeout.`,
              timeoutMs: idleTimeoutMs,
            }),
          );
        }),
      );
    };

    const resetTimer = () => {
      interruptFiber(timeoutFiber);
      if (completionDetected) {
        // Post-signal grace window — successful resolution on expiry.
        timeoutFiber = Effect.runFork(
          Effect.gen(function* () {
            yield* Effect.sleep(Duration.millis(completionTimeoutMs));
            onCompletionTimeout(completionTimeoutMs);
            yield* Deferred.succeed(completionTimeoutDeferred, {
              result: resultText || accumulatedOutput,
              sessionId,
              usage,
            });
          }),
        );
      } else {
        // Pre-signal idle window — failure on expiry unless a streamed tool
        // call still owns a live child-operation window.
        armIdleTimer();
        // Reset warning interval on activity, idle-phase only.
        startWarningInterval();
      }
    };

    // Deferred that will be resolved (as a defect) when the AbortSignal fires.
    // Uses Effect.die so the abort reason propagates as-is to run().
    const abortDeferred = yield* Deferred.make<never, never>();
    let abortCleanup: (() => void) | null = null;
    if (signal) {
      if (signal.aborted) {
        return yield* Effect.die(signal.reason);
      }
      const onAbort = () => {
        Effect.runFork(Deferred.die(abortDeferred, signal.reason));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      abortCleanup = () => signal.removeEventListener("abort", onAbort);
    }

    resetTimer();

    const execEffect = Effect.gen(function* () {
      const printCmd = provider.buildPrintCommand({
        prompt,
        dangerouslySkipPermissions: true,
        resumeSession,
        forkSession,
        systemPrompt,
      });
      const execResult = yield* sandbox.exec(printCmd.command, {
        onLine: (line) => {
          // Surface the raw line FIRST so verbose mode/forwarders see every
          // stdout line the agent produced, including ones parseStreamLine
          // drops. Errors thrown by the callback are caught by the emitter
          // layer; isolate the parser path here so a broken forwarder cannot
          // skip parsing.
          try {
            onRawLine(line);
          } catch {
            // Swallow — must not skip parsing/timer logic below.
          }
          const parsedEvents = provider.parseStreamLine(line);
          let sawToolCall = false;
          let sawAgentProgress = false;
          for (const parsed of parsedEvents) {
            if (parsed.type === "text") {
              sawAgentProgress = true;
              onText(parsed.text);
              accumulatedOutput += parsed.text;
            } else if (parsed.type === "result") {
              sawAgentProgress = true;
              resultText = parsed.result;
              accumulatedOutput += parsed.result;
              onResult?.(parsed.result);
            } else if (parsed.type === "tool_call") {
              sawToolCall = true;
              onToolCall(parsed.name, parsed.args);
            } else if (parsed.type === "reasoning") {
              sawAgentProgress = true;
              onReasoning?.(parsed.text ?? "", parsed.tokens);
            } else if (parsed.type === "session_id") {
              sessionId = parsed.sessionId;
              onObservedSessionId?.(parsed.sessionId);
            } else if (parsed.type === "usage") {
              sawAgentProgress = true;
              usage = parsed.usage;
              onUsage?.(parsed.usage);
            }
          }
          if (sawToolCall) toolCallInFlight = true;
          else if (sawAgentProgress) toolCallInFlight = false;
          // Check for the completion signal AFTER parsing this line so the
          // accumulator contains everything seen so far. Flip to the
          // completion-grace timer the first time the signal appears.
          if (
            !completionDetected &&
            completionSignals.some((sig) => accumulatedOutput.includes(sig))
          ) {
            completionDetected = true;
            interruptFiber(warningFiber);
            warningFiber = null;
          }
          resetTimer();
        },
        cwd: sandboxRepoDir,
        stdin: printCmd.stdin,
      });

      if (execResult.exitCode !== 0) {
        // Prefer stderr; fall back to resultText (from parsed stream events),
        // then to the tail of raw stdout (last 20 non-empty lines).
        let errorDetail = execResult.stderr;
        if (!errorDetail.trim()) {
          errorDetail = resultText;
        }
        if (!errorDetail.trim()) {
          const lines = execResult.stdout.split("\n").filter((l) => l.trim());
          errorDetail = lines.slice(-20).join("\n");
        }
        return yield* Effect.fail(
          new AgentError({
            message: `${provider.name} exited with code ${execResult.exitCode}:\n${errorDetail}`,
          }),
        );
      }

      return { result: resultText || execResult.stdout, sessionId, usage };
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          interruptFiber(timeoutFiber);
          timeoutFiber = null;
          interruptFiber(warningFiber);
          warningFiber = null;
        }),
      ),
    );

    let raced: Effect.Effect<
      { result: string; sessionId?: string; usage?: IterationUsage },
      AgentIdleTimeoutError | SandboxError
    > = Effect.raceFirst(execEffect, Deferred.await(timeoutSignal));
    raced = Effect.raceFirst(raced, Deferred.await(completionTimeoutDeferred));
    if (signal) {
      raced = Effect.raceFirst(
        raced,
        Deferred.await(abortDeferred) as Effect.Effect<never, never>,
      );
    }

    return yield* raced.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          abortCleanup?.();
          interruptFiber(timeoutFiber);
          timeoutFiber = null;
          interruptFiber(warningFiber);
          warningFiber = null;
        }),
      ),
    );
  });

const DEFAULT_COMPLETION_SIGNAL = "<promise>COMPLETE</promise>";
const DEFAULT_IDLE_TIMEOUT_SECONDS = 10 * 60; // 600 seconds
const DEFAULT_COMPLETION_TIMEOUT_SECONDS = 60;

const enrichAbortReason = (
  reason: unknown,
  iterations: IterationResult[],
): void => {
  attachAbortMetadata(reason, { iterations });
};

export interface OrchestrateOptions {
  readonly hostRepoDir: string;
  readonly iterations: number;
  readonly hooks?: SandboxHooks;
  readonly prompt: string;
  readonly branch?: string;
  readonly provider: AgentProvider;
  /** System/contract prompt delivered per-CLI by the provider (claude flag; codex/opencode prepend). */
  readonly systemPrompt?: string;
  readonly completionSignal?: string | string[];
  /** Idle timeout in seconds. If the agent produces no output for this long, it fails with AgentIdleTimeoutError. Default: 600 (10 minutes) */
  readonly idleTimeoutSeconds?: number;
  /**
   * Grace window in seconds after a completion signal is observed in the
   * agent's output. The agent process is expected to exit shortly after
   * emitting the signal; if it does not (because a spawned child is keeping
   * stdout open — see ADR 0019), this timer fires and the iteration resolves
   * successfully with the buffered output. Resets on every subsequent output
   * line, so trailing data (token-usage events, terminal `result` events,
   * structured-output tags) is still captured. Default: 60 seconds.
   */
  readonly completionTimeoutSeconds?: number;
  /** Optional name for the run, prepended to status messages as [name] */
  readonly name?: string;
  /** @internal Test-only override for the idle warning interval in milliseconds. Default: 60000 (1 minute). */
  readonly _idleWarningIntervalMs?: number;
  /** Resume a prior Claude Code session by ID. Applied to iteration 1 only (unless allowIterResume is true). */
  readonly resumeSession?: string;
  /**
   * When true alongside `resumeSession`, fork the session instead of mutating
   * it — the parent JSONL stays intact and the agent writes a new session
   * under a fresh id. Applied to iteration 1 only. See ADR 0018.
   */
  readonly forkSession?: boolean;
  /**
   * When true, chain the sessionId from each iteration forward as the
   * resumeSession for the next iteration. This lets iter 2..N resume from the
   * prior iter's warm prompt-cache instead of starting cold.
   *
   * Requires `iterations > 1` to have any effect. When false (default),
   * only iteration 1 resumes from `resumeSession` (original behaviour).
   */
  readonly allowIterResume?: boolean;
  /** An AbortSignal that cancels the orchestration when aborted. */
  readonly signal?: AbortSignal;
  /** When true, skip prompt expansion (shell expression evaluation). Set for dynamic inline prompts. */
  readonly skipPromptExpansion?: boolean;
  /** Override default timeouts for built-in lifecycle steps. Unset keys keep their defaults. */
  readonly timeouts?: Timeouts;
  /** Forwarded to `withSandboxLifecycle` — see `SandboxLifecycleOptions.keepSourceBranch`. */
  readonly keepSourceBranch?: boolean;
  /**
   * Live-steer provider. Called BEFORE each iteration after the first; resolves
   * the steer text to inject as a `specialUserRequestBlock` into that iteration's
   * prompt, or `undefined` when no steer is pending. Receives the 1-based
   * iteration ordinal so the provider can record which iteration consumed the steer.
   */
  readonly steerProvider?: (iteration: number) => Promise<string | undefined>;
}

/** Per-iteration result carrying an optional session ID. */
export interface IterationResult {
  /** Claude Code session ID extracted from the init line, or undefined for non-Claude agents. */
  readonly sessionId?: string;
  /** Absolute host path to the captured session JSONL, or undefined when capture is disabled or provider is non-Claude. */
  readonly sessionFilePath?: string;
  /** Token usage snapshot from the last assistant message in the session, or undefined when capture is disabled or provider does not support usage parsing. */
  readonly usage?: IterationUsage;
}

export interface OrchestrateResult {
  /** Per-iteration results (use `iterations.length` for the count). */
  readonly iterations: IterationResult[];
  /** The matched completion signal string, or undefined if none fired. */
  readonly completionSignal?: string;
  readonly stdout: string;
  readonly commits: { sha: string }[];
  readonly branch: string;
  /** Host path to the preserved worktree from the last iteration, set when the worktree was left behind due to uncommitted changes on a successful run. */
  readonly preservedWorktreePath?: string;
}

export const orchestrate = (
  options: OrchestrateOptions,
): Effect.Effect<
  OrchestrateResult,
  SandboxError,
  SandboxFactory | Display | AgentStreamEmitter
> => {
  const idleTimeoutMs =
    (options.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_SECONDS) * 1000;
  const completionTimeoutMs =
    (options.completionTimeoutSeconds ?? DEFAULT_COMPLETION_TIMEOUT_SECONDS) *
    1000;
  return Effect.gen(function* () {
    const factory = yield* SandboxFactory;
    const display = yield* Display;
    const streamEmitter = yield* AgentStreamEmitter;
    const { hostRepoDir, iterations, hooks, prompt, branch, provider } =
      options;
    let completionSignals: string[];
    if (options.completionSignal === undefined) {
      completionSignals = [DEFAULT_COMPLETION_SIGNAL];
    } else if (Array.isArray(options.completionSignal)) {
      completionSignals = options.completionSignal;
    } else {
      completionSignals = [options.completionSignal];
    }

    const label = (msg: string): string =>
      options.name ? `[${options.name}] ${msg}` : msg;

    const allCommits: { sha: string }[] = [];
    const allIterations: IterationResult[] = [];
    let allStdout = "";
    let resolvedBranch = "";
    let iterationPreservedPath: string | undefined;

    // Helper: check abort signal and bail via defect so run() can
    // re-throw the signal's reason verbatim (no Sandcastle wrapping).
    const checkAbort = (): Effect.Effect<void> =>
      options.signal?.aborted ? Effect.die(options.signal.reason) : Effect.void;

    // When allowIterResume is true, chain each iteration's sessionId forward.
    // Starts from options.resumeSession (may be undefined); updated after each iter.
    let currentResumeSession = options.resumeSession;

    for (let i = 1; i <= iterations; i++) {
      yield* checkAbort();
      yield* display.status(label(`Iteration ${i}/${iterations}`), "info");

      // Check for live steer between iterations (only from i=2 onward).
      const iterSteerText: string | undefined =
        i > 1 && options.steerProvider
          ? yield* Effect.promise(() => options.steerProvider!(i))
          : undefined;

      const sandboxResult = yield* factory.withSandbox(
        (
          { hostWorktreePath, sandboxRepoPath, applyToHost, bindMountHandle },
          sandbox,
        ) =>
          withSandboxLifecycle(
            {
              hostRepoDir,
              sandboxRepoDir: sandboxRepoPath,
              hooks,
              branch,
              hostWorktreePath,
              applyToHost,
              signal: options.signal,
              timeouts: options.timeouts,
              keepSourceBranch: options.keepSourceBranch,
            },
            sandbox,
            (ctx) =>
              Effect.gen(function* () {
                // Resume session: when allowIterResume is true, chain the
                // sessionId from the prior iteration (warm cache). Otherwise
                // apply resumeSession to iteration 1 only (original behaviour).
                const iterationResumeSession = options.allowIterResume
                  ? currentResumeSession
                  : i === 1
                    ? options.resumeSession
                    : undefined;
                const iterationForkSession =
                  i === 1 ? options.forkSession : undefined;
                if (
                  iterationResumeSession &&
                  bindMountHandle &&
                  provider.sessionStorage
                ) {
                  yield* display.status(label("Resuming session"), "info");
                  yield* Effect.tryPromise({
                    try: () =>
                      provider.sessionStorage!.resumeIntoSandbox({
                        hostCwd: hostRepoDir,
                        sandboxCwd: ctx.sandboxRepoDir,
                        sessionId: iterationResumeSession,
                        handle: bindMountHandle,
                      }),
                    catch: (e) =>
                      new SessionCaptureError({
                        message: `Session resume failed: ${e instanceof Error ? e.message : String(e)}`,
                        sessionId: iterationResumeSession,
                      }),
                  });
                }

                // Preprocess prompt (run !`command` expressions inside sandbox).
                // Inline prompts pass through literally — skip expansion.
                // Between iterations, inject any pending live-steer text as a
                // specialUserRequestBlock appended to the base prompt.
                const steerBlock = iterSteerText
                  ? specialUserRequestBlock(iterSteerText)
                  : null;
                const iterPrompt = steerBlock
                  ? `${prompt}\n\n${steerBlock}`
                  : prompt;
                const fullPrompt = options.skipPromptExpansion
                  ? iterPrompt
                  : yield* preprocessPrompt(
                      iterPrompt,
                      ctx.sandbox,
                      ctx.sandboxRepoDir,
                    );

                yield* display.status(label("Agent started"), "success");

                const captureSession = (
                  sessionId: string,
                  bestEffort: boolean,
                  streamUsage?: IterationUsage,
                ): Effect.Effect<
                  {
                    sessionFilePath: string | undefined;
                    usage: IterationUsage | undefined;
                  },
                  SessionCaptureError
                > =>
                  Effect.gen(function* () {
                    let sessionFilePath: string | undefined;
                    let usage: IterationUsage | undefined = streamUsage;

                    if (
                      !provider.captureSessions ||
                      !provider.sessionStorage ||
                      !bindMountHandle
                    ) {
                      return { sessionFilePath, usage };
                    }

                    if (!bestEffort) {
                      yield* display.status(label("Capturing session"), "info");
                    }

                    yield* Effect.tryPromise({
                      try: () =>
                        provider.sessionStorage!.captureToHost({
                          hostCwd: hostRepoDir,
                          sandboxCwd: ctx.sandboxRepoDir,
                          sessionId,
                          handle: bindMountHandle,
                        }),
                      catch: (e) =>
                        new SessionCaptureError({
                          message: `Session capture failed: ${e instanceof Error ? e.message : String(e)}`,
                          sessionId,
                        }),
                    });
                    sessionFilePath =
                      provider.sessionStorage.hostSessionFilePath(
                        hostRepoDir,
                        sessionId,
                      );

                    if (provider.parseSessionUsage) {
                      const content = yield* Effect.promise(() =>
                        provider
                          .sessionStorage!.readHostSession(
                            hostRepoDir,
                            sessionId,
                          )
                          .catch(() => undefined as string | undefined),
                      );
                      if (content) {
                        const parsedUsage = provider.parseSessionUsage(content);
                        if (parsedUsage) usage = parsedUsage;
                      }
                    }

                    return { sessionFilePath, usage };
                  });

                // Invoke the agent — buffer text deltas so Pi's single-token
                // chunks are displayed as readable multi-word lines.
                const textBuffer = new TextDeltaBuffer((chunk) => {
                  Effect.runPromise(display.textChunk(chunk));
                  Effect.runPromise(
                    streamEmitter.emit({
                      type: "text",
                      message: chunk,
                      iteration: i,
                      timestamp: new Date(),
                    }),
                  );
                });
                const onText = (text: string) => {
                  textBuffer.write(text);
                };
                const onToolCall = (name: string, formattedArgs: string) => {
                  textBuffer.flush();
                  Effect.runPromise(display.toolCall(name, formattedArgs));
                  Effect.runPromise(
                    streamEmitter.emit({
                      type: "toolCall",
                      name,
                      formattedArgs,
                      iteration: i,
                      timestamp: new Date(),
                    }),
                  );
                };
                const onRawLine = (line: string) => {
                  Effect.runPromise(
                    streamEmitter.emit({
                      type: "raw",
                      line,
                      iteration: i,
                      timestamp: new Date(),
                    }),
                  );
                };
                const onReasoning = (text: string, tokens?: number) => {
                  // Reasoning never interrupts the text buffer ordering the way a
                  // tool call does — claude already flushed its text before the
                  // thinking block, and codex/opencode reasoning is a turn/step
                  // summary with no inline text. Forward it straight to observers.
                  Effect.runPromise(
                    streamEmitter.emit({
                      type: "reasoning",
                      message: text,
                      ...(tokens !== undefined ? { tokens } : {}),
                      iteration: i,
                      timestamp: new Date(),
                    }),
                  );
                };
                const onUsage = (usage: IterationUsage) => {
                  Effect.runPromise(
                    streamEmitter.emit({
                      type: "usage",
                      inputTokens: usage.inputTokens,
                      outputTokens: usage.outputTokens,
                      cacheReadInputTokens: usage.cacheReadInputTokens,
                      cacheCreationInputTokens: usage.cacheCreationInputTokens,
                      ...(usage.reasoningTokens !== undefined
                        ? { reasoningTokens: usage.reasoningTokens }
                        : {}),
                      ...(usage.costUsd !== undefined
                        ? { costUsd: usage.costUsd }
                        : {}),
                      iteration: i,
                      timestamp: new Date(),
                    }),
                  );
                };
                const onResult = (result: string) => {
                  textBuffer.flush();
                  Effect.runPromise(
                    streamEmitter.emit({
                      type: "result",
                      result,
                      iteration: i,
                      timestamp: new Date(),
                    }),
                  );
                };
                let observedSessionId: string | undefined;
                const onSessionId = (sessionId: string) => {
                  observedSessionId = sessionId;
                  Effect.runPromise(
                    streamEmitter.emit({
                      type: "sessionId",
                      sessionId,
                      iteration: i,
                      timestamp: new Date(),
                    }),
                  );
                };
                const onIdleWarning = (minutes: number) => {
                  const msg =
                    minutes === 1
                      ? "Agent idle for 1 minute"
                      : `Agent idle for ${minutes} minutes`;
                  Effect.runPromise(display.status(label(msg), "warn"));
                };
                const onCompletionTimeout = (timeoutMs: number) => {
                  Effect.runPromise(
                    display.status(
                      label(
                        `Completion signal seen but agent process is hanging — force-completing after ${timeoutMs / 1000}s grace window.`,
                      ),
                      "warn",
                    ),
                  );
                };
                const invokeAndCapture = Effect.gen(function* () {
                  const {
                    result: agentOutput,
                    sessionId,
                    usage: streamUsage,
                  } = yield* invokeAgent(
                    ctx.sandbox,
                    ctx.sandboxRepoDir,
                    fullPrompt,
                    provider,
                    idleTimeoutMs,
                    completionTimeoutMs,
                    completionSignals,
                    onText,
                    onToolCall,
                    onRawLine,
                    onIdleWarning,
                    onCompletionTimeout,
                    options._idleWarningIntervalMs,
                    iterationResumeSession,
                    iterationForkSession,
                    options.signal,
                    onReasoning,
                    options.systemPrompt,
                    onUsage,
                    onResult,
                    onSessionId,
                  );

                  // Flush any remaining buffered text deltas
                  textBuffer.dispose();

                  yield* display.status(label("Agent stopped"), "info");

                  // Capture session while sandbox is still alive. Usage from the
                  // stream (e.g. Codex's turn.completed) is the baseline; a
                  // session-parsed value below overrides it when available.
                  const { sessionFilePath, usage } = sessionId
                    ? yield* captureSession(sessionId, false, streamUsage)
                    : { sessionFilePath: undefined, usage: streamUsage };

                  // Check completion signal
                  const matchedSignal = completionSignals.find((sig) =>
                    agentOutput.includes(sig),
                  );
                  return {
                    completionSignal: matchedSignal,
                    stdout: agentOutput,
                    sessionId,
                    sessionFilePath,
                    usage,
                  } as const;
                }).pipe(
                  Effect.catchAllCause((cause) =>
                    Effect.gen(function* () {
                      textBuffer.dispose();
                      if (options.signal?.aborted) {
                        const partialSessionId = observedSessionId;
                        const partialCapture = partialSessionId
                          ? yield* captureSession(partialSessionId, true).pipe(
                              Effect.catchAll(() =>
                                Effect.succeed({
                                  sessionFilePath: undefined,
                                  usage: undefined,
                                }),
                              ),
                            )
                          : {
                              sessionFilePath: undefined,
                              usage: undefined,
                            };
                        enrichAbortReason(options.signal.reason, [
                          ...allIterations,
                          {
                            sessionId: partialSessionId,
                            sessionFilePath: partialCapture.sessionFilePath,
                            usage: partialCapture.usage,
                          },
                        ]);
                      }
                      return yield* Effect.failCause(cause);
                    }),
                  ),
                );

                return yield* invokeAndCapture;
              }),
          ),
      );

      const lifecycleResult = sandboxResult.value;
      iterationPreservedPath = sandboxResult.preservedWorktreePath;

      allCommits.push(...lifecycleResult.commits);
      allStdout += lifecycleResult.result.stdout;
      resolvedBranch = lifecycleResult.branch;

      allIterations.push({
        sessionId: lifecycleResult.result.sessionId,
        sessionFilePath: lifecycleResult.result.sessionFilePath,
        usage: lifecycleResult.result.usage,
      });

      // When allowIterResume is enabled, carry this iteration's sessionId
      // forward so the next iteration resumes from the warm cache.
      if (options.allowIterResume && lifecycleResult.result.sessionId) {
        currentResumeSession = lifecycleResult.result.sessionId;
      }

      if (lifecycleResult.result.completionSignal !== undefined) {
        yield* display.status(
          label(`Agent signaled completion after ${i} iteration(s).`),
          "success",
        );
        return {
          iterations: allIterations,
          completionSignal: lifecycleResult.result.completionSignal,
          stdout: allStdout,
          commits: allCommits,
          branch: resolvedBranch,
          preservedWorktreePath: iterationPreservedPath,
        };
      }
    }

    yield* display.status(
      label(`Reached max iterations (${iterations}).`),
      "info",
    );
    return {
      iterations: allIterations,
      completionSignal: undefined,
      stdout: allStdout,
      commits: allCommits,
      branch: resolvedBranch,
      preservedWorktreePath: iterationPreservedPath,
    };
  });
};
