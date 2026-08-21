# Runner: OpenCode

> **Unattended posture.** What makes this Agent able to work with nobody at the
> keyboard — and the evidence behind it — is
> [`runner-unattended-posture.md`](./runner-unattended-posture.md).

How `/afk` invokes OpenCode as the inner agent for one issue (ADR 0059, amended).
OpenCode is the **API-auth** runner: it reaches OpenAI-compatible endpoints
through its own `<provider>/<model>` slug and an API key, with no host session
of its own. The other two runners (Claude Code, Codex) authenticate through an
interactive host session; OpenCode is the lane that runs where there is no such
session — notably the CI Actions lane.

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

OpenCode is a first-class sandcastle agent (`@reddb-io/worker` ships
`opencode(model, options)`), so AFK does **not** assemble a CLI invocation itself —
it injects the provider through the `agentFor` seam (ADR 0033) and sandcastle owns
the spawn, the worktree, the sandbox, and completion-signal detection. The wiring
lives in `execution.ts` (`buildAgent`) and the env-resolution in `opencode-env.ts`:

- **model** — OpenCode's own `<provider>/<model>` slug, taken verbatim from the
  resolved `afk.models.opencode.<tier>.model` entry and forwarded unchanged. The
  leading segment (`openrouter/`, `openai/`, `minimax/`, …) tells OpenCode which
  endpoint to dispatch to. AFK does not parse or validate the segment — that is
  OpenCode's job.
- **variant** — AFK's per-tier `effort` maps to `OpenCodeOptions.variant` (OpenCode's
  own reasoning knob, a free-form string such as `low`/`medium`/`high`). Unlike
  Claude/Codex, which take a numeric `effort`, OpenCode's variant is not gated —
  the configured effort passes straight through.
- **env** — the auth API key is delivered through `OpenCodeOptions.env`. The
  first set env-var from the precedence list wins (see *Auth env precedence*
  below); that single `{ [envVar]: value }` is the entire auth payload. AFK does
  not encode base URLs, auth headers, or endpoint routing — OpenCode owns that
  from the slug and the key.

The handoff/prompt, branch strategy, sentinels, and continuous-push behaviour are
identical to the other runners — they are owned by the shared execution layer, not
the runner.

## Auth env precedence

OpenCode reaches any OpenAI-compatible endpoint through the auth env-var +
`<provider>/<model>` slug combination. Set **one** of the precedence entries in
the worker process; the corresponding leading segment in the model slug tells
OpenCode which endpoint to talk to. First match wins:

| precedence | env-var | slug prefix | endpoint |
|---|---|---|---|
| 1 | `OPENAI_API_KEY` | `openai/...` | OpenAI direct |
| 2 | `MINIMAX_API_KEY` | `minimax/...` | MiniMax subscription API |
| 3 | `OPENROUTER_API_KEY` | `openrouter/<vendor>/...` | OpenRouter (relay) |

Rationale: OpenAI wins because it is the most direct / lowest-friction default
for a public OpenAI-compatible endpoint; MiniMax wins over OpenRouter because a
subscription key is preferable to a paid relay when the user already has one.
A user with no key set is fail-closed: the agent is spawned without an auth
`env` block, OpenCode surfaces its own auth error, and the run routes through
the normal failure path. The full resolver is unit-tested in
`tests/opencode-env.test.ts`.

Back-compat with the original #626 contract: when **only** `OPENROUTER_API_KEY`
is set, behaviour is byte-for-byte identical to the pre-amendment runner — the
slug flows through and the key rides in `OpenCodeOptions.env` under
`OPENROUTER_API_KEY`. No existing config or test changes are required.

## Model tier table (ADR 0049)

Defaults under `afk.models.opencode.<tier>.{model,effort}` mirror the Claude tier
**capabilities** (cheap → strong) over OpenRouter — back-compat with #626.
Operators override per repo via `plugins.dev.afk.models.opencode.*` in
`.red/config.yaml` to point the tiers at any OpenAI-compatible endpoint
(e.g. `openai/gpt-4o-mini`, `minimax/MiniMax-M3`,
`openrouter/google/gemini-...`).

| tier | default model | variant (effort) | use |
|---|---|---|---|
| validate | `openrouter/anthropic/claude-3.5-haiku` | low | fuzzy/semantic checks; the AFK per-issue classifier |
| simple | `openrouter/anthropic/claude-sonnet-4` | high | simple, well-specified, single-scope code |
| complex | `openrouter/anthropic/claude-opus-4` | medium | cross-module / architectural / risk-sensitive code |
| think | `openrouter/anthropic/claude-opus-4` | high | design, planning, routing (the default class) |

## Exhaustion Detection

OpenCode surfaces quota / rate-limit exhaustion through whatever endpoint it is
talking to (OpenAI, OpenRouter, MiniMax, …). The orchestrator's exhaustion
matcher (`isRunnerExhausted`, `runner-spawn.ts`) keys off these substrings in
the agent output / error chain:

- `usage limit`, `weekly cap`, `session exhausted`, `try again later`,
- `quota`, `rate_limit` / `rate_limit_error`,
- HTTP `402` (insufficient credits) / `429` (rate limited) responses carrying
  one of the substrings above.

On any of those the orchestrator emits the internal `RUNNER_EXHAUSTED` signal,
preserves the worktree, and (only under `--fallback-runner`) swaps to the
alternate runner. Note that the alternate is a session-auth runner (claude/codex);
in an API-key-only lane with no host session, run OpenCode **without**
`--fallback-runner` so an exhaustion is terminal-through-recovery rather than a
swap to an unavailable runner.

## Task mirror (headless — no surface)

OpenCode is the `headless` row of the Task-mirror host capability matrix
(`taskMirrorCapability("opencode")`, SKILL.md *Task Mirror And Codex Monitor
Agent*). Because it has **no host session**, there is no native task list and no
sub-agent UI to mirror worker progress into: the OpenCode runner is not a Claude
Code-style native-task host, and it is not the Codex monitor-agent fallback
either. `monitor --mirror-plan --runner opencode` therefore emits an **empty
plan** — no `TaskCreate`/`TaskUpdate` calls — and the canonical progress surface
for an OpenCode lane is the `monitor` dashboard read directly from the worker
state files. This is the honest no-parity position: do not invent a cross-runner
task abstraction to pretend OpenCode has a surface it does not (ADR 0003).

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
  contract covers local invocation given one of the auth env-vars above.
