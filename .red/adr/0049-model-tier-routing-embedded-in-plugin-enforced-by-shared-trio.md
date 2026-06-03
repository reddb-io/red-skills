# Model-tier routing is embedded in the plugin and enforced by the shared skill + hooks + sandcastle trio, per runner

Status: accepted (not yet implemented)

## Context

Running every task on the largest model is slow and expensive. We want work routed to the **cheapest capable** model/effort: structural validation costs no model at all, fuzzy checks go to a small model, simple code to a mid model, complex code and all deep reasoning to the large model. This must hold both in the **interactive session** and in the **autonomous AFK loop**, and across **both runners** (Claude Code and Codex) — not as a soft prose rule a reader might ignore, but embedded in the plugin so every repo that installs it inherits the policy.

## Decision

A single **tier table** — per runner, mapping each tier to `{model, effort}` — lives in the dev plugin's **config defaults** (`config.ts` `CONFIG_DEFAULTS`, e.g. `afk.models.{claude,codex}.{validate,simple,complex,think}`), overridable per-repo via `.red/config.yaml`. It is consumed by the three **host-neutral, shared** surfaces the plugin already ships to both runners:

- **skill** — carries the policy + the classification criterion (the single source of *why/which*, read by both hosts);
- **hooks** — enforce the routing on subagent dispatch in the **interactive** session, on both hosts;
- **sandcastle** — enforces the **AFK** side: the inner-agent spawn already takes `--model` and `--effort`, so the per-issue tier resolves straight into those flags.

Tiers (Claude family; Codex maps to its own gpt-5.x family via the per-runner adapter, ADR 0003):

| tier | model | effort | use |
|---|---|---|---|
| validate | `claude-haiku-4-5` | low | fuzzy/semantic content checks (structural JSON/YAML/schema validation runs as a **deterministic tool first — zero model tokens**); also the AFK classifier |
| simple | `claude-sonnet-4-6` | high | simple, well-specified, single-scope code |
| complex | `claude-opus-4-8` | medium | cross-module / architectural / risk-sensitive code |
| think | `claude-opus-4-8` | high | design, planning, routing decisions |

Classification is **per-issue** in AFK (a cheap `haiku` classifier reads lightweight metadata before the spawn; under the Codex runner a small gpt model plays the same role) and **inline-opus** in the interactive session (the main loop is already reasoning). Simple-vs-complex uses an explicit criterion **plus escalate-on-failure**: a `simple` attempt that fails the feedback gate is retried on `complex`, so a misclassification costs one cheap miss, not a wedged loop.

## Considered options

- **Policy in `CLAUDE.md` / consumer-repo files** — rejected: soft, not embedded in the plugin, and a plugin cannot auto-inject always-on session context anyway.
- **A single identical mechanism across both hosts** — infeasible: Codex plugins ship no `agents/` and do not use the Claude model family; the realization must be per-runner (the existing `.claude-plugin`/`.codex-plugin` and `runner-claude.md`/`runner-codex.md` split, ADR 0003).
- **Per-task routing within one issue** (nested subagent dispatch inside an AFK attempt) — deferred as a stretch goal: it needs nested-spawn capability that is unverified; per-issue tiering at the spawn is what sandcastle enforces natively today.

## Consequences

- One embedded config source, three shared readers (skill/hooks/sandcastle), two runners — no duplicated tier table to desync.
- The **effort inversion is deliberate**: the cheap model thinks harder (sonnet/high) while the strong model spends less per token on already-designed code (opus/medium), and reasoning itself stays maximal (opus/high).
- Effort is a **real knob** in the AFK spawn (`--effort`) and Codex reasoning-effort; in the interactive Claude tier-agents it is prompt-convention until/unless agent frontmatter exposes an `effort` field.
- AFK tiering is **coarse (per-issue)** for now; finer within-issue routing is left open.
- Codex's interactive per-task subagent-with-model capability is **unverified** — if absent, the Codex interactive session falls back to a single model but still inherits AFK tier-routing.
