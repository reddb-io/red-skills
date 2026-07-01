# OpenCode is the third AFK runner, addressing OpenRouter through its own model slug

## Status

accepted, **amended** — see *Amendment 1* and *Amendment 2* below; a third
amendment (*Amendment 3*) lives in **ADR 0075** and adds the host-side
`opencode.json` `provider>` block so the developer-facing opencode TUI and
the AFK inner-agent opencode runner pick the same model from the same
project config. The runner-level semantics (slug forwarding, env precedence,
fail-closed no-env) are unchanged; Amendment 3 is a **new consumer** of the
same `.red/config.yaml` block, not a behaviour change.

**Refined by ADR 0062:** the Actions-lane packaging introduced here is now a
composite action + reusable workflow (the lane's runtime contract is unchanged).

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

## Amendment 1 — endpoint-agnostic provider, env-precedence auth

**Status:** accepted.
**Date:** 2026-06-10.
**Slice:** issue #638 (follows #626 and this ADR).

### Context

The original #626 contract hardcoded OpenRouter as the only reachable endpoint:
the provider read `OPENROUTER_API_KEY` and the model slug always carried an
`openrouter/<vendor>/<model>` prefix. That works for a relay but blocks two
real-world needs:

1. A user with a **MiniMax subscription API key** (no OpenRouter account) cannot
   drive the runner without re-routing through OpenRouter as a paid relay.
2. A user who already has an `OPENAI_API_KEY` and wants to talk to OpenAI
   direct — not through OpenRouter — has to invent a slug OpenRouter happens to
   expose (`openrouter/openai/gpt-4o-mini`) instead of using OpenCode's
   first-class `openai/gpt-4o-mini`.

OpenCode itself already knows how to talk to OpenAI, OpenRouter, MiniMax, and
any other OpenAI-compatible endpoint — it dispatches on the leading segment of
the model slug. The endpoint resolution belongs in OpenCode, not in AFK.

### Decision

**AFK only propagates the auth key. OpenCode owns endpoint resolution.**

Concretely:

- The model slug accepted at the config layer is `<provider>/<model>`. AFK
  forwards it verbatim to OpenCode; AFK does not parse, validate, or rewrite
  the leading segment.
- The auth env-var is selected by **first-set precedence** (no config block,
  no override):
    1. `OPENAI_API_KEY` — `openai/...` slug
    2. `MINIMAX_API_KEY` — `minimax/...` slug
    3. `OPENROUTER_API_KEY` — `openrouter/<vendor>/...` slug
- The full resolver lives in `src/core/opencode-env.ts` (a pure module) and is
  unit-tested in `tests/opencode-env.test.ts`. The auth key rides in
  `OpenCodeOptions.env` under the env-var's own name — OpenCode reads it
  directly. No base URL, no auth header, no endpoint-specific code in AFK.
- A user with no key set is fail-closed: the agent is spawned without an
  auth `env` block, OpenCode surfaces its own auth error, the run routes
  through the normal failure path.
- Back-compat with the #626 contract: when **only** `OPENROUTER_API_KEY` is
  set, behaviour is byte-for-byte identical to the pre-amendment runner.
  Existing configs, tests, and the runner-opencode.md contract are forward-
  compatible.

### Considered options

- **Hardcoded base URLs per env-var** — rejected: duplicates endpoint logic
  AFK should not own; OpenCode already knows.
- **Config block per endpoint** (e.g. `afk.opencode.endpoints: [openai, ...]`) —
  rejected: the user has already expressed their choice by which env-var they
  set; a second config layer is ceremony.
- **Auto-detect endpoint by which env-var is set, but require a config flag
  to enable MiniMax** — rejected: MiniMax is a first-class OpenAI-compatible
  endpoint; gating it behind a config flag is paternalism.

### Consequences

- A user with `MINIMAX_API_KEY=…` and a tier config
  `afk.models.opencode.think.model: minimax/MiniMax-M3` runs the inner agent
  against the MiniMax subscription API with **no** further configuration.
- A user with `OPENAI_API_KEY=…` and `afk.models.opencode.think.model:
  openai/gpt-4o-mini` runs against OpenAI direct.
- The previous "OpenRouter-only" framing in the contract, the SKILL.md cascade
  notes, and the CONFIG_DEFAULTS comments is replaced by the
  *Auth env precedence* table in `runner-opencode.md`. Defaults stay
  OpenRouter-shaped for back-compat.
- `--fallback-runner` semantics are unchanged: it swaps to a session-auth
  runner, which is unavailable in an API-key-only lane. The
  *Exhaustion Detection* section notes this and recommends running OpenCode
  without `--fallback-runner` in that case.

## Amendment 2 — anchored in the MiniMax subscription case (2026-06-10)

**Status:** accepted (narrative follow-up to Amendment 1).
**Context:** issue #638 PR review.

Amendment 1 generalised the OpenCode runner to any OpenAI-compatible endpoint
on principled grounds (AFK should not own endpoint logic; OpenCode already
does). This amendment records the **concrete use case** that exposed the gap
and motivated the change, so future maintainers do not regress it under
"simpler is better" pressure.

### The case

A reddb.io maintainer had a **MiniMax subscription API key** (`MINIMAX_API_KEY`)
in their environment and wanted to run the AFK inner agent against a MiniMax
model. Under the #626 contract the only reachable endpoint was OpenRouter:
the runner hardcoded `OPENROUTER_API_KEY` and the model slug had to carry an
`openrouter/<vendor>/<model>` prefix. The maintainer's options were:

1. Spin up an OpenRouter account, buy credits, route the MiniMax model
   through OpenRouter as a paid relay — paying twice for the same model.
2. Edit AFK code to special-case `MINIMAX_API_KEY` — a one-off patch that
   would not generalise to OpenAI, Anthropic direct, or any other
   OpenAI-compatible endpoint.
3. Argue that endpoint resolution is OpenCode's job and let the runner
   become endpoint-agnostic — Amendment 1.

Option 3 was the only one that survived the next ten users with different
endpoints. The contract landed in the same shape as Amendment 1
(`<provider>/<model>` slug + env-precedence auth), and the maintainer's
MiniMax subscription started working with the config:

```yaml
plugins:
  dev:
    afk:
      models:
        opencode:
          think:
            model: minimax/MiniMax-M3
            effort: high
```

plus `MINIMAX_API_KEY=…` in the worker process env. No AFK code change per
endpoint, no extra config block, no OpenRouter account required.

### What this amendment commits to

- The endpoint-agnostic property from Amendment 1 is **load-bearing** for
  MiniMax subscription users (and the same shape extends to any other
  OpenAI-compatible endpoint). Reverting it would re-block that user class.
- The env-precedence order (`OPENAI > MINIMAX > OPENROUTER`) is the
  documented order; changing it is an ADR amendment, not a code change.
- Defaults stay OpenRouter-shaped for back-compat with #626 — operators
  opting into a different endpoint override `afk.models.opencode.<tier>.model`
  explicitly, but the no-config case still works against OpenRouter.
- The "fail-closed no env" behaviour (no key set → OpenCode surfaces its
  own auth error → normal failure path) is part of the contract. A future
  refactor must not silently spawn an agent without an `env` auth block
  when a precedence entry IS set.

## See also

- **ADR 0075** — *OpenCode provider block is the canonical shape that hosts
  the AFK opencode runner on a developer machine.* Refines this ADR with
  **Amendment 3**: the same `<provider>/<model>` slug and env-precedence
  rule are now also written into the `opencode.json` `provider>` block by
  the `apps/opencode-host/` generator, so a developer typing into the
  opencode TUI sees the same model the AFK inner agent would pick.
