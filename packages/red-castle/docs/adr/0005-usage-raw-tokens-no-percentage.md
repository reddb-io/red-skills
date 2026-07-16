# Usage exposes raw token counts, not context window percentage

`IterationResult.usage` reports raw token counts (`inputTokens`, `cacheCreationInputTokens`, `cacheReadInputTokens`, `outputTokens`) extracted from the last assistant message in the agent session JSONL. It deliberately omits `contextWindowSize` and `usedPercentage`, even though these are the metrics callers most naturally want.

Context window size is not available from any data source Sandcastle reads. The session JSONL contains token counts but not the model's context limit. Claude Code's statusline mechanism provides `context_window_size`, but it is a display feature piped to a configured shell script — not accessible from the streaming output or session files. Even that source has known accuracy issues: as of 2026-04, some models report incorrect values (e.g. `claude-sonnet-4-6` reports 200,000 instead of 1,000,000). A hardcoded model-to-size lookup table was rejected as stale-prone and subject to the same bugs.

Callers who know the context window size for their model can compute percentage themselves from the raw counts.

## Considered Options

- **Hardcoded lookup table** mapping model names to context window sizes. Rejected: stale-prone, and Claude Code itself has bugs in this mapping.
- **Inject a statusline script into the sandbox** to capture Claude Code's statusline JSON. Rejected: awkward plumbing for an orchestrator, and the data has known accuracy issues.
- **Caller-provided `contextWindowSize`** on run options. Rejected for now: shifts burden to the user for a value the system should know. Can be revisited if a reliable source emerges.
