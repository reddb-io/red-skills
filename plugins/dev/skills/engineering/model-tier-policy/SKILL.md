---
name: model-tier-policy
working-mode: interactive
description: Use when choosing or explaining the RedSkills dev model tier for validation, simple code, complex code, design, or AFK execution across Claude Code and Codex.
---

# model-tier-policy

**Route every AFK task to the cheapest capable tier and escalate on evidence — never copy this table into executor prompts; point executors here so the classification criterion stays in one place.**

This is the dev plugin's cross-host policy for why a task uses a given model tier and which tier should run it. It is the human-readable policy from ADR 0049.

The machine source for model ids and effort values is `apps/plugin-dev/src/core/config.ts` (`CONFIG_DEFAULTS`), overridden per repository by `.red/config.yaml` at `plugins.dev.afk.models.{claude,codex,opencode}.{validate,simple,complex,think}`. The legacy top-level `afk.models...` location remains a fallback.

**Runtime override (flag / env, ADR 0049).** Like `--runner`/`RED_AFK_RUNNER` and `RED_AFK_SANDBOX`, the model and effort are overridable at run time without editing a file — for ad-hoc runs and the CI lane. Precedence: **`--model` flag > `RED_AFK_MODEL` env > `.red/config.yaml` > defaults** (and the same for `--effort` / `RED_AFK_EFFORT`). A non-empty override **flattens every tier** onto the one slug ("use this model regardless of tier"); `""` is treated as unset. The `--model`/`--effort` flags pre-set the env so the override flows through both `--once` and the fleet. Example — drive OpenCode against a MiniMax subscription with no config edit: `MINIMAX_API_KEY=… afk run --runner opencode --model minimax/MiniMax-M3 --issues 42` (the slug's leading segment routes the endpoint; `opencode-env.ts` picks the key). The CI composite action exposes this as the `model`/`effort` inputs.

## Tier table

| tier | default Claude model / effort | default Codex model / effort | default Claude-MiniMax model / effort | use |
|---|---|---|---|---|
| `validate` | `claude-haiku-4-5` / `low` | `gpt-5.5` / `low` | `MiniMax-M3` / `low` | Fuzzy or semantic validation, contract review, fixture sanity checks, and AFK task classification after deterministic checks have run. |
| `simple` | `claude-sonnet-4-6` / `high` | `gpt-5.5` / `high` | `MiniMax-M3` / `low` | Well-specified, single-scope code where expected files and behavior are clear and blast radius is small. |
| `complex` | `claude-opus-4-8` / `medium` | `gpt-5.5` / `medium` | `MiniMax-M3` / `low` | Cross-module, architectural, public-contract, migration, security-sensitive, data-risky, concurrency-sensitive, or otherwise high-blast-radius code. |
| `think` | `claude-opus-4-8` / `high` | `gpt-5.5` / `high` | `MiniMax-M3` / `low` | Design, planning, issue routing, broad diagnosis, and cases where the right execution tier is not yet clear. |

## Deterministic-first validation

Use deterministic tools before the `validate` tier whenever the question is structural: schema validation, JSON/YAML parsing, shell syntax, type checks, lint, tests, contract fixtures, and exact file or metadata checks. Those checks should spend zero model tokens first. Use `validate` only for fuzzy/semantic judgment, such as whether prose satisfies a spec, whether a fixture is coherent, or which AFK execution tier an issue should receive after cheap evidence is gathered.

## Simple vs complex

Classify as `simple` only when all of these are true:

- The request is well specified and the expected behavior is concrete.
- The change is single-scope: one component, one workflow, or a small set of tightly related files.
- It does not alter architecture, public APIs, persisted data shape, release/build machinery, auth, permissions, secrets, destructive operations, or cross-runner contracts.
- The likely validation path is narrow and deterministic.
- A failed attempt would not leave ambiguous partial state or require a redesign.

Classify as `complex` when any of these are true:

- The change crosses module, package, service, runner, or host boundaries.
- It changes architecture, public contracts, schemas, migrations, security posture, data-loss behavior, concurrency, merge/branch policy, or autonomous execution safety.
- The blast radius is uncertain, the code path is unfamiliar, or the validation evidence must be interpreted across multiple subsystems.
- A `simple` attempt failed the feedback gate, exposed hidden scope, or needed assumptions that were not in the original task.

Use `think` before coding when the work is mostly design, planning, routing, diagnosis, or deciding between competing approaches.

## Escalation

Start with the cheapest capable tier, but escalate immediately when evidence shows the tier is wrong.

- `validate` returns a verdict with evidence; uncertainty routes to `simple`, `complex`, or `think` instead of stretching validation into implementation.
- `simple` escalates to `complex` when it crosses a boundary, changes a contract, hits security/data-risk, fails feedback validation, or discovers the task was under-scoped.
- `complex` escalates to `think` when implementation should pause for design, product clarification, or routing.
- AFK may retry a failed `simple` execution as `complex`; the intended cost of misclassification is one cheap miss, not a stuck loop.

## Codex interactive

Interactive Codex runs a **single session model** for the main session and any
host-level presentation subagents. Even when a Codex host exposes a native
sub-agent UI, RedSkills does not yet have a per-task subagent-with-model
primitive analogous to Claude's tiered `Task`/`Agent` wrappers, so an
interactive session cannot pin a per-call model/effort. The model tier still
applies to Codex through **AFK tier-routing**: the codex runner adapter (#455)
resolves the per-issue tier into the sandcastle spawn's `--model`/`--effort`.
See ADR 0049.

## Executors

- Claude interactive executors live in `plugins/dev/agents/validate.md`, `plugins/dev/agents/simple-code.md`, and `plugins/dev/agents/complex-code.md`. They are Claude-only wrappers over this policy.
- Codex receives this same skill through `plugins/dev/.codex-plugin/plugin.json` (`"skills": "./skills/"`). Codex does not ship the Claude `agents/` wrappers.
- AFK sandcastle execution lives in `plugins/dev/skills/engineering/afk/SKILL.md`, with host adapters in `runner-claude.md`, `runner-codex.md`, and `runner-claude-minimax.md` (the MiniMax lane, which pins `MiniMax-M3` and caps effort to `low`). Runtime tier resolution flows through `resolveTier` in `apps/plugin-dev/src/core/process-issue.ts` and the config resolver in `apps/plugin-dev/src/core/config.ts`.
- Host hooks live in `plugins/dev/hooks/claude.hooks.json` and `plugins/dev/hooks/codex.hooks.json`; they are host-specific enforcement surfaces, not places to duplicate the policy.

## Interactive enforcement (issue #456, ADR 0049)

The interactive session's tier is enforced — not merely suggested — by a PreToolUse hook on the subagent-dispatch tool (`Task`/`Agent`). On Claude Code, `plugins/dev/hooks/claude.hooks.json` routes the dispatch payload through the daemon's `route-model-tier` command (`apps/plugin-dev/src/commands/route-model-tier.ts`, pure decision in `core/model-tier-route.ts`). The command:

- maps a dispatch to a tier-agent (`validate` → `validate`, `simple-code` → `simple`, `complex-code` → `complex`) and asks `resolveTier` for the policy model from the **single config source** (`plugins.dev.afk.models.claude.<tier>.model`); it hardcodes no model id;
- when the dispatched model's family disagrees with the tier (or is unset), corrects it via the enforcement contract decided at HITL on 2026-06-08: **(a) rewrite** the dispatch model in place using Claude's `hookSpecificOutput.updatedInput` → **(b) fallback block-and-retry** (`permissionDecision: "deny"`) → **(c) degrade to audit** (`additionalContext`). Claude supports rewrite, so it always takes path (a);
- leaves dispatches to any non-tier subagent untouched (the hook enforces a declared tier, it does not semantically classify arbitrary tasks).

Codex safe-degrades to a no-op until the per-task subagent-with-model capability lands (#457): the `route-model-tier --host codex` path emits no change, and `codex.hooks.json` does not wire an enforcing hook yet. When #457 resolves Codex's dispatch tool shape, wire it the same way — the command already accepts `--host codex` and the contract is shared, so there is still exactly one tier table.
