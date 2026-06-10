# OpenCode is the third AFK runner, addressing OpenRouter through its own model slug

## Status

accepted.

## Context

AFK ships two inner-agent runners — Claude Code and Codex — each integrated the
same per-runner way: a `runner-<name>.md` contract (spawn shape, stdout parsing,
exhaustion strings, model-tier table) plus a sandcastle agent provider injected
through the `agentFor` seam (ADR 0003 per-runner adapters, ADR 0033 sandcastle
execution substrate, ADR 0049 model-tier routing). Both are **session-auth**: the
runner authenticates through an interactive host session (a logged-in Claude Code
or Codex), and the detection cascade can therefore sniff "which host am I running
under" from ambient env / process tree / script path.

We want a third runner that runs where there is **no host session** — most
concretely the CI Actions lane — and that reaches a broad set of models through a
single API key. OpenCode over OpenRouter fits: OpenCode is a coding agent that
addresses any OpenRouter model through its own `openrouter/<vendor>/<model>` slug
and an `OPENROUTER_API_KEY`. sandcastle 0.6.6 already ships `opencode(model,
options)` as a first-class agent, where `OpenCodeOptions.env` carries the API key
and `OpenCodeOptions.variant` is OpenCode's reasoning knob — so no upstream
sandcastle work is needed, only AFK-side wiring.

The novelty versus the existing two runners is that OpenCode has no caller
identity: **no host session is ever OpenCode**. Auto-sniffing it would be
incorrect by construction.

## Decision

Integrate OpenCode as the third runner following the established per-runner
pattern, with one deliberate divergence in the detection cascade:

- **Contract.** `plugins/dev/skills/engineering/afk/runner-opencode.md` documents
  the provider wiring, the OpenRouter slug + env seam, the per-tier model table,
  and the exhaustion strings.
- **Provider.** `execution.ts` adds `opencode` to `AgentRunner` and a pure,
  unit-tested `buildAgent` seam that maps a runner+model+effort to a sandcastle
  provider. For opencode it forwards the `openrouter/<vendor>/<model>` slug
  unchanged, maps AFK's per-tier `effort` to OpenCode's `variant` (no gating —
  variant is a free-form string), and delivers `OPENROUTER_API_KEY` through
  `OpenCodeOptions.env`. `defaultSandcastleDeps` binds the real
  `core.{claudeCode,codex,opencode}` factories and `process.env`.
- **Detection — explicit pin only.** `opencode` joins the runner vocabulary so
  `--runner opencode` and `RED_AFK_RUNNER=opencode` validate, but is added to
  **none** of the ambient-detection surfaces (env keys, process-tree regex, script
  path). The cascade can never resolve to opencode from caller identity; only an
  explicit pin or an operator-configured `afk.default_runner: opencode` selects it.
- **Model tiers.** `config.ts` `CONFIG_DEFAULTS` gains `afk.models.opencode.<tier>.
  {model,effort}` rows (validate/simple/complex/think), and `resolveTier` reads the
  opencode table for an opencode runner. Defaults mirror the Claude tier
  capabilities over OpenRouter; operators override per repo under
  `plugins.dev.afk.models.opencode.*` (ADR 0042 unified config).

## Considered options

- **Auto-sniff opencode like claude/codex** — rejected: there is no OpenCode host
  session to detect, so any sniff would be a false positive. Pin-only is the
  correct model for an API-auth runner.
- **A generic OpenRouter runner decoupled from OpenCode** — rejected: it would
  duplicate the agent/spawn machinery sandcastle's `opencode` provider already
  owns, and OpenRouter is reachable purely through OpenCode's own slug, so the
  thin path is to ride the existing provider.
- **Thread the API key through a new `agentFor` parameter** — rejected as
  unnecessary surface: the key lives in the worker environment, and `buildAgent`
  reads it from the injected `env`, keeping the `agentFor` signature unchanged and
  the env passthrough unit-testable with a fake env.

## Consequences

- AFK gains an API-auth lane that runs without a host session — the substrate the
  CI Actions lane needs. The CI E2E that exercises that lane end-to-end is a
  separate slice; this decision covers the runner integration and local invocation
  given an `OPENROUTER_API_KEY`.
- `effort` is overloaded across runners: a numeric knob for Claude/Codex (gated per
  provider, FIX D) and a free-form `variant` string for OpenCode. `buildAgent`
  centralises both so the divergence is in one tested place.
- Auxiliary host-CLI spawns that predate this work — the per-issue classifier, the
  merge conflict resolver, the validation sidecar — still branch only on
  `codex` vs `claude` and fall to the `claude` branch under an opencode pin. They
  degrade safely (the host spawn returns non-zero rather than throwing, so the
  classifier falls back to its deterministic result), but routing them through
  OpenCode is deferred to the Actions-lane slice.
- `--fallback-runner` swaps to a session-auth runner on exhaustion; in an
  OpenRouter-only lane with no host session, opencode should run without it so an
  exhaustion is terminal-through-recovery rather than a swap to an unavailable
  runner.
