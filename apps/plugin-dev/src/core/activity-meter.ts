// activity-meter — a tiny per-attempt counter over the agent's normalised
// stream events, surfaced into the proof-of-life heartbeat so liveness is
// readable at a glance rather than inferred from cpu/rss alone.
//
// The caller feeds only the activity/cost-bearing red-castle events here. Raw
// stdout, terminal result, and session-id metadata are logged elsewhere because
// they are useful diagnostics but not worker-activity units.
//
//   - tools_called_count — cumulative `toolCall` events this attempt
//   - text_chunk_count   — cumulative `text` events this attempt
//   - waiting_count      — cumulative heartbeat WINDOWS (≈ one per guard poll)
//     in which the agent emitted ZERO new stream events. A window with no
//     output means the agent produced nothing between two ticks — it was
//     blocked/waiting (on a tool result, an API round-trip, or genuinely hung).
//     Distinct from cpu/rss (a wedged subprocess still burns cpu) and from the
//     line-diff (which only moves on a commit), so a rising waiting_count with a
//     flat diff is the cleanest "stuck vs working" signal we can derive without
//     touching red-castle.
//
// Pure and deterministic: no clock, no IO. The caller stamps timestamps. The
// per-window bookkeeping is driven by `snapshotWindow()`, called once per
// heartbeat tick.

/** The minimal shape this meter reads off a normalised stream event. */
export interface StreamEventLike {
  /** `usage` is accepted so the sink can forward every stream event unfiltered.
   * It is not counted as a tool/text/reasoning liveness unit, but it DOES feed
   * the cumulative cost group (ADR 0065) via the fields below. */
  readonly type: "text" | "toolCall" | "reasoning" | "usage";
  /** Reasoning token count, when the runner exposes it (codex/opencode). */
  readonly tokens?: number;
  /** Cost group, present on `usage` events only — per-turn/step token spend that
   * `record()` sums into the cumulative attempt totals. */
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
  /** The cached halves of the same turn's input side. Summed with `inputTokens`
   * into the LAST-observed context level (#3097) — never into a cumulative
   * total, because a context window is a level and cache reads would double-count
   * the same resident prompt on every turn. */
  readonly cacheReadInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
}

/** The counters surfaced into a heartbeat tick. All cumulative for the attempt. */
export interface ActivitySnapshot {
  /** Cumulative `toolCall` events observed this attempt. */
  readonly toolsCalled: number;
  /** Cumulative `text` events observed this attempt. */
  readonly textChunks: number;
  /**
   * Cumulative `reasoning` events. claude streams one per thinking block;
   * codex/opencode emit one per reasoning-bearing turn/step. The unit differs
   * per runner, but a non-zero value always means the model is actively
   * reasoning — present on all three CLIs.
   */
  readonly reasoningCount: number;
  /**
   * Cumulative reasoning TOKENS, summed from events that carry a count
   * (codex/opencode). claude folds thinking tokens into output and does not
   * break them out, so a claude attempt accrues `reasoningCount` but 0 tokens.
   */
  readonly reasoningTokens: number;
  /** Cumulative heartbeat windows with no new stream event (waiting/blocked). */
  readonly waiting: number;
  /** New stream events since the previous `snapshotWindow()` (0 → a waiting window). */
  readonly eventsThisWindow: number;
  /** Cost group (ADR 0065) — cumulative token spend summed from `usage` events.
   * Fed live by codex/opencode (per-turn/step usage); claude's usage arrives at
   * the iteration boundary, not the stream, so a pure-claude attempt accrues 0
   * here (its cost is a follow-up). */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Cumulative USD cost when the runner reports it directly, else 0. */
  readonly costUsd: number;
  /**
   * Input-side tokens the LAST `usage` event carried — the context window's
   * occupancy, in the engine's own spelling (`inputTokens +
   * cacheCreationInputTokens + cacheReadInputTokens`).
   *
   * Overwritten rather than summed: this is a level, not a total. 0 means no
   * runner has reported one, which for claude is the ordinary state — its usage
   * arrives at the iteration boundary rather than on the stream.
   */
  readonly contextTokens: number;
}

export interface ActivityMeter {
  /** Record one normalised stream event (call from the agent-event sink). */
  record(event: StreamEventLike): void;
  /**
   * Close the current heartbeat window and open the next. Increments `waiting`
   * when no events arrived since the previous call. Returns the cumulative
   * snapshot to fold into the heartbeat record. Idempotent only across distinct
   * ticks — each call advances the window boundary.
   */
  snapshotWindow(): ActivitySnapshot;
  /** Read the cumulative counters without advancing the window (for tests/state reads). */
  peek(): ActivitySnapshot;
}

/**
 * Create a fresh meter for one attempt. A new attempt gets a new meter so the
 * counts never bleed across the per-issue attempt boundary.
 */
export function createActivityMeter(): ActivityMeter {
  let toolsCalled = 0;
  let textChunks = 0;
  let reasoningCount = 0;
  let reasoningTokens = 0;
  let waiting = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let contextTokens = 0;
  // Total events at the last window boundary, to derive per-window deltas.
  let eventsAtLastWindow = 0;

  // `usage` is deliberately excluded — it is a cost meta-event, not a liveness
  // unit, so it never resets the waiting window.
  const total = (): number => toolsCalled + textChunks + reasoningCount;

  return {
    record(event) {
      if (event.type === "toolCall") toolsCalled += 1;
      else if (event.type === "text") textChunks += 1;
      else if (event.type === "usage") {
        if (typeof event.inputTokens === "number") inputTokens += event.inputTokens;
        if (typeof event.outputTokens === "number") outputTokens += event.outputTokens;
        if (typeof event.costUsd === "number") costUsd += event.costUsd;
        const level =
          (event.inputTokens ?? 0) + (event.cacheCreationInputTokens ?? 0) + (event.cacheReadInputTokens ?? 0);
        if (level > 0) contextTokens = level;
      } else if (event.type === "reasoning") {
        reasoningCount += 1;
        if (typeof event.tokens === "number" && event.tokens > 0) reasoningTokens += event.tokens;
      }
    },
    snapshotWindow() {
      const eventsThisWindow = total() - eventsAtLastWindow;
      if (eventsThisWindow <= 0) waiting += 1;
      eventsAtLastWindow = total();
      return {
        toolsCalled,
        textChunks,
        reasoningCount,
        reasoningTokens,
        waiting,
        eventsThisWindow: Math.max(0, eventsThisWindow),
        inputTokens,
        outputTokens,
        costUsd,
        contextTokens,
      };
    },
    peek() {
      return {
        toolsCalled,
        textChunks,
        reasoningCount,
        reasoningTokens,
        waiting,
        eventsThisWindow: total() - eventsAtLastWindow,
        inputTokens,
        outputTokens,
        costUsd,
        contextTokens,
      };
    },
  };
}
