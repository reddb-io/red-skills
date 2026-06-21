# `claude-minimax` is a first-class AFK runner pointing at MiniMax's Anthropic-compatible endpoint

## Status

accepted.

Relates: [PRD #788](https://github.com/reddb-io/red-skills/issues/788) (claude-minimax spike), issue #789 (wiring), issue #790 (HITL gate / spike outcome), issue #795 (this documentation), [ADR 0033](0033-agentfor-seam-maps-provider-dispatch.md) (`agentFor` provider dispatch), [ADR 0049](0049-model-tier-policy-is-the-single-source-for-execution-model-routing.md) (model tier policy), [ADR 0059](0059-opencode-is-the-third-afk-runner-over-openrouter.md) (OpenCode runner).

## Context

AFK runs tasks on one of three execution environments (runners):

1. **Claude Code** (`claude`) — interactive host session, Claude Code CLI directly on the user's machine
2. **Codex** (`codex`) — interactive host session, Codex CLI directly on the user's machine
3. **OpenCode** (`opencode`) — API-auth runner, reaches OpenAI-compatible endpoints (OpenAI, OpenRouter, MiniMax, …) via `<provider>/<model>` slug and an API key

All three reach Anthropic's real Claude API (or equivalent quality models via relay) **except** one niche use-case: when a user or organization has a **MiniMax subscription** (a Chinese AI provider reselling Anthropic models via an Anthropic-compatible endpoint) and prefers not to call Anthropic's API directly for compliance, cost, or latency reasons.

**Before this decision:** the only way to reach MiniMax from AFK was via the OpenCode runner (tier 3, `openrouter/...` or `minimax/...` slug). That works, but OpenCode is an API-auth-only lane with no host session — it is not reachable from an interactive Claude Code session, and operators cannot easily toggle between real Anthropic and MiniMax for testing or migration.

**Problem:** operators with a MiniMax subscription want a **session-auth runner** (like Claude Code) that transparently swaps the endpoint URL and API key without requiring an OpenCode install/config step or changing the whole runner. They want to call `afk --runner claude-minimax` just like `--runner claude`, get the same Claude Code CLI spawn, but hit MiniMax's `api.minimax.io/anthropic` instead of Anthropic's real API.

## Decision

Add a **fourth first-class runner, `claude-minimax`**, that reuses the unchanged `claude-code` red-castle provider but injects two environment variables into the inner spawn so Claude Code's Anthropic client talks to MiniMax instead:

```
ANTHROPIC_API_KEY   ← resolved from MINIMAX_API_KEY (orchestrator env)
ANTHROPIC_BASE_URL  ← hardcoded to https://api.minimax.io/anthropic
```

### Why a new runner, not an env-toggle or `--endpoint` flag?

1. **Explicit-pin semantics.** OpenCode is accepted **only as an explicit pin** (`--runner opencode` or `RED_AFK_RUNNER=opencode`), never auto-sniffed. MiniMax follows the same rule: **never auto-sniffed from ambient `MINIMAX_API_KEY`**. This makes the intent explicit and prevents accidental cross-endpoint runs.

2. **Single responsibility.** The `claude-code` provider remains Anthropic-only; `claude-minimax` is a thin routing layer over it. A future `--endpoint` / `--base-url` flag would couple the provider to arbitrary endpoint swapping, which is OpenCode's job.

3. **Convergence with existing runner taxonomy.** Operators already understand the runner selection surface: `--runner <name>`, `RED_AFK_RUNNER`, config defaults, and auto-detection per host. Adding `claude-minimax` as a first-class runner extends that surface predictably rather than introducing a new `--endpoint` concept.

### Why not merge MiniMax into OpenCode as a plugin provider?

OpenCode is **already** Anthropic-endpoint-agnostic: it speaks any OpenAI-compatible endpoint and the operator chooses the slug at runtime (`minimax/MiniMax-M3` is already valid). The decision is not about adding MiniMax to OpenCode — it is about letting session-auth users (who have a live Claude Code session) reach MiniMax without installing / switching to an API-key-only lane.

### Why hardcode the base URL?

MiniMax has a single public endpoint at `https://api.minimax.io/anthropic`. Making it configurable (e.g. via an env-var or config key) would increase surface area and maintenance burden without immediate benefit — no operator has stated a need for multiple MiniMax endpoints. Future slices can make it configurable if the need arises; the spike confirmed the hardcoded URL works.

### Why pin the model to `MiniMax-M3`?

MiniMax-M3 is the only Claude-Code-compatible model MiniMax exposes on their Anthropic-compat endpoint (at the time of the spike gate, #790). Forcing the model prevents accidental misconfigurations (e.g. requesting a non-existent tier model). If MiniMax adds more Claude-compatible models in the future, a later slice can generalize the pin.

### Why cap effort to `low`?

MiniMax-M3 does **not** accept extended thinking (thinking: `{type: "enabled", budget: N}`). When effort is `medium`, `high`, or `xhigh`, Claude Code 4.x auto-selects extended thinking to maximize capability. Spawning with the wrong thinking mode causes MiniMax to reject the request outright.

**Solution:** the runner **caps all effort to `low`** (which does not trigger thinking). Any higher requested effort is degraded with a warning. This ensures reliability; a later feature might make it configurable once MiniMax adopts extended thinking, but capping is the safe default.

## Implementation

- New runner type `claude-minimax` added to the runner discriminated union (`apps/dev/src/types/runner.ts`).
- Runner selection (`runner-detection.ts`) accepts explicit pins only; never auto-sniffed.
- Provider dispatch (`execution.ts` / `buildAgent`) routes `claude-minimax` to the unchanged `claude-code` provider with:
  - Model fixed to `MINIMAX_M3` (discards the tier-resolved model).
  - Effort capped to `low` (degrades higher efforts with a warning).
  - Inner spawn env block injected via `resolveMiniMaxClaudeEnv` (maps `MINIMAX_API_KEY` → `ANTHROPIC_{API_KEY, BASE_URL}`).
- Auth env mapping pure function (`minimax-env.ts`) mirrors OpenCode's pattern for testability.
- Runner documentation (`plugins/dev/skills/engineering/afk/runner-claude-minimax.md`) covers selection, spawn, exhaustion, transient failures, and working directory.
- Model tier policy updated to list `claude-minimax` in the tier table (all tiers mapped to `MiniMax-M3` / `low`).
- No config keys added; the runner is selected the same way as Claude/Codex (`--runner`, `RED_AFK_RUNNER`, config default). The `MINIMAX_API_KEY` env-var is the only new required environment variable.

## Testing

- Unit tests for the auth env resolver (`minimax-env.test.ts`).
- Runner detection tests verify the runner is accepted only as an explicit pin and never auto-sniffed.
- Integration tests verify the provider dispatch injects the correct env block and model.
- Exhaustion and transient-failure detection tests (re-use existing matchers; no MiniMax-specific logic needed).

## Consequences

- Operators with a MiniMax subscription can now run AFK against MiniMax using a session-auth runner, reducing friction compared to the OpenCode lane.
- The `claude-code` provider remains Anthropic-only in semantics (no new config keys, no endpoint flag); MiniMax routing is explicit via runner selection.
- The hardcoded base URL and pinned model reduce flexibility; future slices may relax these constraints if needed.
- Exhaustion and transient-failure signals flow through the same orchestrator matchers as all other runners; no new failure modes.
- A future runner (e.g. for another Anthropic-compatible provider) can follow the same pattern: explicit pin + thin routing layer over an existing provider.
