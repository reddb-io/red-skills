// activity-meter — a tiny per-attempt counter over the agent's normalised
// stream events, surfaced into the proof-of-life heartbeat so liveness is
// readable at a glance rather than inferred from cpu/rss alone.
//
// red-castle's public `AgentStreamEvent` carries only `text` and `toolCall`
// today (the raw per-CLI streams also carry reasoning/usage, but the parsers
// drop them — extending that is a separate red-castle change). So this meter
// counts exactly what the three runners (claude / codex / opencode) already
// deliver identically:
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
  /** `usage` is accepted so the sink can forward every stream event unfiltered,
   * but it is a cost meta-event (ADR 0065 cost group) — `record()` does not count
   * it as a tool/text/reasoning liveness unit. */
  readonly type: "text" | "toolCall" | "reasoning" | "usage";
  /** Reasoning token count, when the runner exposes it (codex/opencode). */
  readonly tokens?: number;
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
  // Total events at the last window boundary, to derive per-window deltas.
  let eventsAtLastWindow = 0;

  const total = (): number => toolsCalled + textChunks + reasoningCount;

  return {
    record(event) {
      if (event.type === "toolCall") toolsCalled += 1;
      else if (event.type === "text") textChunks += 1;
      else if (event.type === "reasoning") {
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
      };
    },
  };
}
