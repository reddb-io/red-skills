# Provider Error Retry Logic

**Decision:** Sandcastle does not retry on provider errors (rate limits, auth failures, quota errors, network timeouts, etc.).

**Why:**

- Sandcastle shells out to provider CLIs (e.g. Claude Code) — it doesn't own the API connection or error interface.
- Parsing provider-specific error shapes to detect retryable conditions means taking responsibility for an interface we don't control and that could change at any time.
- Blindly retrying on any non-zero exit code would mask real errors (bad prompts, auth failures, config issues) and waste time/money.
- Failing fast gives users immediate feedback they can act on — upgrade a plan, wait, or switch providers.

**Principle:** Error handling and retry logic belong in the provider/harness layer, not in Sandcastle. Sandcastle fails fast on provider errors.

**Rejected in:** #246
