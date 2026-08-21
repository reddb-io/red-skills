---
"@reddb-io/dev": patch
---

Wire the standing drain declaration so it registers, and validate it against the Agent ids the registration actually speaks (#4293).

`readStandingDrain` had no production caller — one re-export in `config.ts` and three assertions in `config.test.ts` — so `plugins.dev.afk.standing: {runner, target}` registered nothing and a `drain` with no runner argument dropped the declared executor. The MCP adapter's startup now reads the declaration and sends one ensure-style `drain` for it, `drainInputFor` completes an underspecified drain from the same declaration, and an incomplete block stays inert and says so on the adapter's stderr. The declaration is validated against `ACP_AGENT_IDS` rather than the legacy `Runner` union, which refused `claude-code` and accepted runners the daemon's catalog cannot launch. A new `invariants:declared-config-consumers` ratchet fails when a declared config reader has no non-test caller.
