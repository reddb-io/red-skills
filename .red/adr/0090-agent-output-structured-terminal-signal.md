# AgentOutput — a native structured terminal signal, claude-first, coexisting with the text sentinel

## Status

Accepted. Implements S6 of PRD #928 (issue #932). Introduces the `AgentOutput`
schema in the AFK execution substrate (red-castle, ADR 0061) and wires the
claude runner to emit + validate it, alongside — not replacing — the existing
text sentinel (`<promise>DONE</promise>`, referenced by ADR 0033).

## Context

An AFK worker signals "I am done" with a **text sentinel**: the inner agent
prints `<promise>DONE</promise>` (or `<promise>BLOCKED</promise>`) as its final
line, and red-castle's `completionSignal` matching stops the iteration loop. This
sentinel is fragile — an agent can simply forget to emit it. A forgotten
sentinel maps to the `no-sentinel` outcome, the single largest recorded worker
failure class (the #788 spike: 2.1M tokens burned on one slice, DONE never
emitted, zero slices closed). The sentinel is a *convention the agent must
remember*, not a *contract the runner enforces*.

red-castle already ships a generic structured-output mechanism (`Output.object`,
`extractStructuredOutput`, `StructuredOutputError`). But that path validates
`RunResult.output` and **requires `maxIterations === 1`** — it is a single-shot
feature. AFK runs multi-iteration (up to `DEFAULT_MAX_ITERATIONS = 20`, ADR
0033/#322), so it cannot adopt `run({ output })` as-is: the terminal signal must
work *across* the iteration loop, not gate a single invocation.

Not every runner can emit a validated schema equally well, and flipping all
runners at once would be a risky big-bang against the live fleet. The maintainer
(HITL on #932) approved a minimal schema and a **per-runner, claude-first**
rollout with the sentinel kept as a coexisting fallback.

## Decision

### 1. The `AgentOutput` schema lives in red-castle

`packages/red-castle/src/AgentOutput.ts` defines the cross-repo contract (a zod
schema, which satisfies Standard Schema and matches the existing `Output`
tooling):

| field | type | meaning |
|---|---|---|
| `success` | `boolean` | did the attempt achieve its goal? |
| `summary` | `string` | one-paragraph description of what the attempt did |
| `key_changes_made` | `string[]` | the concrete changes landed |
| `key_learnings` | `string[]` | durable facts worth carrying forward |
| `should_fully_stop` | `boolean` | agent believes no further attempt is warranted |

The agent emits it in an `<agent-output>...</agent-output>` block (JSON body,
fence-aware). `extractAgentOutput(stdout)` is a **synchronous, self-contained**
helper (no `ExtractionContext`) that finds the *last* such block and validates
it, returning a discriminated `{ ok: true, value } | { ok: false, reason }` —
usable as a terminal-signal gate on a multi-iteration run. The shared
`agentOutput` `Output.object` binding keeps the single-shot `run({ output })`
path on the same schema.

The schema lives in the substrate because it is a **contract between red-castle
and every consumer**, not AFK-private policy. Changed via the 2-repo flow (ADR
0061): edit + commit + push in the submodule, then bump the pointer in red-skills.

### 2. Per-runner enforcement, gated by `RUNNER_SPECS[runner].structuredOutput`

`RunnerSpec` gains a `structuredOutput?: boolean` capability flag (the single
seam — "add a runner = one row", #823). `runnerSupportsStructuredOutput(runner)`
reads it. Both the emit side and the validate side consult this one flag, so
flipping a runner onto the schema is a one-line change.

- **Emit** (`handoff.ts`): `exitProtocolFor({ runMode, structuredOutput })` splices
  the `AGENT_OUTPUT_INSTRUCTION` clause into the exit protocol *only* for a
  schema-enabled runner. red-castle deliberately never injects completion
  instructions itself, so the exit protocol is where the agent learns the
  contract.
- **Validate** (`execution.ts`): `enforceStructuredOutput(runner, outcome, stdout)`
  is a pure gate wired into `runAgent`'s terminal return. On a schema-enabled
  runner, a `done` outcome whose stdout lacks a valid `AgentOutput` is
  **downgraded to `no-sentinel`** — routing a forgotten schema through the exact
  recovery path a forgotten sentinel already uses (crash envelope, label
  rotation, bounded retry). This is what makes it true that, on a schema-enabled
  runner, an agent **cannot terminate "done" without a valid `AgentOutput`**.
  Only `done` is gated; `blocked` / `no-sentinel` / exhaustion / timeout pass
  through untouched (a schema is required to *claim success*, not to report a
  block).

### 3. Coexist, don't replace — claude first

The text sentinel is NOT removed. It remains the completion signal red-castle
matches to stop the loop, and the *sole* terminal signal for runners without
native schema support. On a schema-enabled runner the two coexist: the agent
emits the `<agent-output>` block immediately before its `<promise>…</promise>`
line — schema as the machine-readable terminal signal, sentinel as its
human-readable companion. `claude` ships with `structuredOutput: true`; `codex`,
`opencode`, and `claude-minimax` keep the sentinel-only path. The sentinel is
deprecated runner-by-runner as each flips the flag on.

## Consequences

- The `no-sentinel` failure class is now *catchable* on claude: a DONE without a
  valid schema no longer silently merges half-finished work — it is rejected and
  recovered, and the warning names the exact validation failure.
- claude workers must now emit `AgentOutput`. The exit protocol instructs them
  to; a forgotten block degrades gracefully to `no-sentinel` (bounded retry),
  the same as a forgotten sentinel today — no new terminal failure mode.
- The schema is a cross-repo contract: changing its fields is a red-castle change
  landed via the 2-repo flow, and consumers pick it up on the pointer bump.
- Downstream outcome handling is unchanged: the gate reuses the existing
  `no-sentinel` outcome rather than introducing a new one, so no switch in
  `attempt-outcome.ts` / `process-issue.ts` needs to grow a branch.

## Three-condition ADR test

1. **Significant?** Yes — it changes the worker's terminal-signal contract, the
   root of the largest recorded failure class, and adds a cross-repo schema.
2. **Cross-cutting?** Yes — spans red-castle (schema), the runner-policy table,
   the agent-facing exit protocol, and the execution outcome mapping.
3. **Hard to reverse?** Yes — it is a per-runner contract other runners will
   adopt incrementally; the schema shape becomes a dependency of every consumer.
