# Runner: OpenCode

How `/afk` invokes OpenCode as the inner agent for one issue (ADR 0059). OpenCode
is the **API-auth** runner: it addresses OpenRouter through OpenCode's own model
slug and an API key, with no host session of its own. The other two runners
(Claude Code, Codex) authenticate through an interactive host session; OpenCode
is the lane that runs where there is no such session — notably the CI Actions lane.

## Selection — explicit pin only

OpenCode is accepted **only as an explicit pin**:

- `--runner opencode`, or
- `RED_AFK_RUNNER=opencode`.

It is **never auto-sniffed** from caller identity (ambient env, process tree, or
script path) — no host session is OpenCode, so there is nothing to sniff. The
detection cascade (`runner-detection.ts`) lists opencode in the runner vocabulary
so the flag / env pin validates, but adds opencode to none of the ambient-detection
surfaces. An operator-configured `afk.default_runner: opencode` is honoured (that
is configuration, not a sniff).

## Spawn

OpenCode is a first-class sandcastle agent (`@ai-hero/sandcastle` ≥ 0.6.6 ships
`opencode(model, options)`), so AFK does **not** assemble a CLI invocation itself —
it injects the provider through the `agentFor` seam (ADR 0033) and sandcastle owns
the spawn, the worktree, the sandbox, and completion-signal detection. The wiring
lives in `execution.ts` (`buildAgent`):

- **model** — OpenCode's own `openrouter/<vendor>/<model>` slug, taken verbatim
  from the resolved `afk.models.opencode.<tier>.model` entry and forwarded
  unchanged. OpenRouter is addressed purely through this slug; there is no
  separate provider config.
- **variant** — AFK's per-tier `effort` maps to `OpenCodeOptions.variant` (OpenCode's
  own reasoning knob, a free-form string such as `low`/`medium`/`high`). Unlike
  Claude/Codex, which take a numeric `effort`, OpenCode's variant is not gated —
  the configured effort passes straight through.
- **env** — the OpenRouter API key is delivered through `OpenCodeOptions.env` as
  `OPENROUTER_API_KEY`, read from the worker process environment. This is the auth
  seam: under a container sandbox (which does not inherit `process.env`) the
  explicit `env` option is what carries the key into the agent.

The handoff/prompt, branch strategy, sentinels, and continuous-push behaviour are
identical to the other runners — they are owned by the shared execution layer, not
the runner.

## Model tier table (ADR 0049)

Defaults under `afk.models.opencode.<tier>.{model,effort}` mirror the Claude tier
**capabilities** (cheap → strong) over OpenRouter. Operators override per repo via
`plugins.dev.afk.models.opencode.*` in `.red/config.yaml` — point the tiers at any
OpenRouter vendor/model (e.g. `openrouter/openai/...`, `openrouter/google/...`).

| tier | default model | variant (effort) | use |
|---|---|---|---|
| validate | `openrouter/anthropic/claude-3.5-haiku` | low | fuzzy/semantic checks; the AFK per-issue classifier |
| simple | `openrouter/anthropic/claude-sonnet-4` | high | simple, well-specified, single-scope code |
| complex | `openrouter/anthropic/claude-opus-4` | medium | cross-module / architectural / risk-sensitive code |
| think | `openrouter/anthropic/claude-opus-4` | high | design, planning, routing (the default class) |

## Exhaustion Detection

OpenCode rides OpenRouter, so quota / rate-limit exhaustion surfaces as OpenRouter
errors. The orchestrator's exhaustion matcher (`isRunnerExhausted`, `runner-spawn.ts`)
keys off these strings in the agent output / error chain:

- `usage limit`, `weekly cap`, `session exhausted`, `try again later`,
- `quota`, `rate_limit` / `rate_limit_error`,
- OpenRouter HTTP `402` (insufficient credits) / `429` (rate limited) responses,
  which carry one of the substrings above.

On any of those the orchestrator emits the internal `RUNNER_EXHAUSTED` signal,
preserves the worktree, and (only under `--fallback-runner`) swaps to the
alternate runner. Note that the alternate is a session-auth runner (claude/codex);
in an OpenRouter-only lane with no host session, run OpenCode **without**
`--fallback-runner` so an exhaustion is terminal-through-recovery rather than a
swap to an unavailable runner.

## Working Directory

OpenCode runs with the sandcastle-created worktree as its working directory and
has filesystem access only inside it, exactly like the other runners. The handoff
file lives one level above the worktree, at
`.red/tmp/workers/{id}/{N}-a{n}/handoff.md`, so it survives runner retries.

## Known limitations (this slice)

- The per-issue **classifier** and the merge **conflict resolver** / **validation
  sidecar** spawn a host CLI directly (`codex` or, by default, `claude`) rather
  than OpenCode. Under an opencode pin they fall to the `claude` branch; if no
  Claude session is present the classifier degrades cleanly to its deterministic
  result (the host spawn returns non-zero, never throws), so the attempt is not
  wedged. Routing these auxiliary spawns through OpenCode is left to the CI
  Actions-lane slice.
- The CI E2E that exercises the Actions lane end-to-end is a separate slice; this
  contract covers local invocation given an `OPENROUTER_API_KEY`.
