# Structured-output completion contract — a validated `AgentOutput` schema coexists with the `<promise>` sentinel

## Status

Accepted. Maintainer approved the schema shape, per-runner enforcement mapping,
sentinel coexistence strategy, and rollout order on 2026-07-01 (issue #911,
parent PRD #907). Implementation is delegated to #932 (claude) and subsequent
per-runner slices; this ADR is the design decision only.

## Context

Every AFK attempt ends when the inner agent authors a completion signal. Today
that signal is the text sentinel `<promise>DONE</promise>` /
`<promise>BLOCKED</promise>` grepped out of the runner's stdout stream (ADR
0028). The sentinel is the *canonical* agent-authored exit; pipe EOF and process
exit are only crash detectors.

The sentinel is fragile precisely because it is free text the agent must
remember to print verbatim at the very end of its turn. This produces a whole
failure class the orchestrator has been patching downstream for months:

1. **`no-sentinel`** — the agent finishes the work, commits it, and exits
   without ever printing the token. EOF-without-sentinel is read as a crash
   (`on_attempt_error`), the issue does not auto-close, and the branch strands.
   ADR 0047 (salvage a no-sentinel branch that already passes feedback) and ADR
   0055/0056 (the reconcile lane that re-validates and lands parked branches)
   exist *only* to repair this after the fact.

2. **DONE-without-commit** — the agent prints `<promise>DONE</promise>` but never
   committed, producing an empty branch. ADR 0050 (salvage an uncommitted
   worktree when the agent emits DONE without committing) is the codex-specific
   net for this.

3. **`#788`-never-emitted-DONE** — an agent burns its entire token budget on a
   single slice and hits quota without ever reaching the sentinel line. From the
   orchestrator's view this is indistinguishable from a mid-run crash.

Each of these has its own salvage/reconcile path bolted on. They share one root
cause: **the completion signal is unstructured free text, so the agent can
finish the work but fail to emit a parseable end-state.** A text token printed at
the end of a long turn is easy to forget, easy to malform, and impossible for the
API layer to enforce.

Modern runner APIs can enforce a structured response *at the transport layer*:
the model is constrained to emit a JSON object matching a supplied schema, and
the API rejects any completion that does not conform. If the completion signal is
that schema-constrained object, the agent *cannot* finish its turn without
authoring a valid, machine-readable end-state — the root cause disappears for any
runner that supports it.

## Decision

Add `AgentOutput`, a structured-output completion channel enforced per runner at
the API layer, as a **parallel channel alongside the existing sentinel — not a
replacement.** Both channels are active during rollout; the sentinel remains a
fully valid completion signal until every runner supports the schema. This is a
coexistence strategy, deliberately not a cutover.

### 1. The `AgentOutput` schema

```typescript
interface AgentOutput {
  success: boolean;         // did the attempt achieve its goal?
  summary: string;          // one-paragraph human-readable outcome
  key_changes_made: string[];   // what changed, for the PR body / audit trail
  key_learnings: string[];      // gotchas worth persisting (feeds memory/wiki)
  should_fully_stop: boolean;   // outer-loop signal: exhaust queue vs. continue
}
```

The two booleans carry the control-flow semantics the sentinel encodes today:

- `success: true` maps to the `done` outcome (equivalent to
  `<promise>DONE</promise>`); `success: false` maps to `blocked` (equivalent to
  `<promise>BLOCKED</promise>`).
- `should_fully_stop: true` is the structured equivalent of the outer-loop
  exhaustion sentinel `<promise>NO MORE TASKS</promise>` — the worker drains no
  further issues.

`summary`, `key_changes_made`, and `key_learnings` are net-new signal the text
sentinel never carried. They feed the PR body, the attempt audit trail, and the
memory/wiki ingestion paths for free — a side benefit of forcing structure, not
the reason for it.

### 2. Coexistence, not replacement

`interpretOutcome` treats **either channel** as a valid attempt close:

- A valid `AgentOutput` JSON object → outcome derived from `success` /
  `should_fully_stop`, as above.
- A `<promise>` sentinel → outcome derived exactly as today (ADR 0028),
  unchanged.
- Neither → `no-sentinel`, unchanged (still routed to the salvage/reconcile lanes
  of ADRs 0047/0050/0055).

Precedence when both appear: **the structured `AgentOutput` wins.** A runner that
emits a schema-constrained object has, by construction, authored a
machine-validated end-state; a same-turn sentinel is at most a redundant echo. If
only the sentinel is present (a non-adopting runner, or an adopting runner that
somehow bypassed the schema), the sentinel path applies untouched. This keeps
every existing caller and every existing runner working with zero behaviour
change on the sentinel side.

### 3. Per-runner enforcement

Each runner enforces the schema through its own native structured-output
mechanism at the API layer:

- **claude** — `--json-schema <path>` on the CLI / `output_schema` in
  `RunOptions`. The response is constrained to the `AgentOutput` shape.
- **codex** — `--output-schema`.
- **openai / minimax (opencode)** — JSON mode (response-format JSON object
  constrained to the schema).
- **ACP** — the schema is embedded in the agent-client protocol request.

Enforcement lives in each runner adapter (the red-castle layer), so the
orchestrator sees one uniform `AgentOutput` regardless of which runner produced
it. Runners with no structured-output capability simply never populate the
channel and continue to rely on the sentinel — that is the coexistence guarantee
in practice.

### 4. Rollout order

Adoption is **claude → codex → others (openai/minimax, ACP)**. Each runner's
adoption is gated by its own implementation slice; a runner is not considered
"structured" until its slice lands and is verified against real attempts. The
sentinel stays canonical for every not-yet-adopted runner, so the rollout is
incremental and reversible per runner.

- **claude** — first, tracked by #932 (includes the HITL gate for the schema
  shape).
- **codex** — second, once claude is proven in the field.
- **openai/minimax and ACP** — subsequent per-runner slices.

### 5. red-castle interface changes required

The implementation (delegated, not done here) requires these changes to the
vendored red-castle runner substrate and its dev-side consumers, all
backward-compatible:

1. **`RunOptions` gains an optional `outputSchema` field.** When present, the
   runner adapter passes it to the runner via that runner's native mechanism
   (`--json-schema`, `--output-schema`, JSON mode, or embedded schema per §3).
   When absent — every existing caller — the adapter behaves exactly as today.
   The field is optional, so this is a non-breaking addition.

2. **`interpretOutcome` checks for a valid `AgentOutput` JSON object in addition
   to the text sentinel.** The current signature
   (`interpretOutcome(signal: string | undefined): AgentOutcome` in
   `apps/dev/src/core/execution.ts`) is extended to recognise a structured
   completion first, then fall through to `DONE_SIGNAL` / `BLOCKED_SIGNAL`
   detection, then `no-sentinel`. Sentinel detection is **unchanged**; the
   structured check is purely additive and takes precedence per §2.

3. **No breaking change to existing callers.** The schema field is optional and
   defaults off; `no-sentinel` semantics and the salvage/reconcile lanes are
   untouched; any runner or caller that ignores the new field keeps working.

## Consequences

- **The `no-sentinel` / DONE-without-commit / #788-never-emitted-DONE class is
  eliminated for every adopting runner.** A schema-constrained completion cannot
  be forgotten or malformed — the API rejects a non-conforming turn — so the
  agent cannot finish without authoring a valid end-state. The salvage/reconcile
  lanes (ADRs 0047/0050/0055/0056) remain in place for non-adopting runners and
  as defence-in-depth, but stop being the primary correctness mechanism for
  adopting ones.

- **Backward compatible by construction.** The sentinel channel is untouched;
  the schema field is optional; precedence is well-defined. A repo running an
  older bundle, a runner without structured output, or a caller that never sets
  `outputSchema` sees zero behaviour change.

- **Richer attempt signal for free.** `summary`, `key_changes_made`, and
  `key_learnings` give the PR body, audit trail, and memory/wiki ingestion
  structured content the sentinel never carried — improving downstream
  observability without a separate extraction step.

- **Incremental, reversible rollout.** Because adoption is per-runner and gated
  by slices, a runner whose structured output misbehaves in the field can fall
  back to the sentinel channel with no orchestrator change — the coexistence
  design *is* the rollback plan.

- **Implementation is delegated.** This ADR makes the design call only. #932
  implements the claude adopter (with its own HITL gate); codex and the
  remaining runners follow in subsequent slices. No code changes land with this
  ADR.

## Rejected alternatives

- **Replace the sentinel outright with `AgentOutput`.** Rejected. A hard cutover
  would break every not-yet-adopted runner (codex, openai/minimax, ACP) and every
  older installed bundle the moment it landed. Coexistence lets each runner move
  independently and keeps the fragile-but-working sentinel as the floor.

- **Keep patching the sentinel with more salvage/reconcile lanes.** Rejected.
  ADRs 0047/0050/0055/0056 are all downstream repairs for one upstream defect
  (unstructured completion signal). Adding more repair paths treats symptoms;
  structured output removes the cause for runners that support it.

- **A single cross-runner IPC channel (Unix socket / named pipe) for the
  completion object.** Rejected, matching ADR 0028's reasoning: it forces every
  runner adapter to learn a non-native channel and abandons the "the runner's
  own constrained output declares its end" property. Native per-runner
  structured output reuses each API's existing enforcement instead.

- **Make `AgentOutput` advisory (parsed if present, never enforced).** Rejected.
  An unenforced schema is just the sentinel with more fields — the agent can
  still forget it. The value is entirely in the API-layer *enforcement* that
  makes a non-conforming completion impossible.

## Related

- ADR 0028 — the `<promise>` sentinel as the canonical attempt-exit signal; this
  ADR adds a parallel structured channel that coexists with it and, for adopting
  runners, supersedes it as the primary completion contract. (ADR 0028 §Rejected
  alternatives already anticipated this: "Promote the sentinel into a structured
  envelope on stdout … can land later.")
- ADR 0047 — no-sentinel salvage (a downstream repair this ADR removes the need
  for, on adopting runners).
- ADR 0050 — uncommitted-worktree salvage on DONE-without-commit (same).
- ADR 0055 / 0056 — the no-agent reconcile lane and landability reconciler (kept
  as defence-in-depth; no longer the primary correctness mechanism for adopting
  runners).
- ADR 0061 — AFK runs on the vendored red-castle submodule; the `RunOptions` /
  runner-adapter changes land there via the two-repo flow.
- ADR 0081 §Related — cites this contract as the sibling addressing the `/afk`
  completion signal with a validated `AgentOutput` schema.
- PRD #907 — parent program (Track E — obedience).
- Issue #911 — this ADR. Issue #932 — the claude implementation slice (with HITL
  gate).

## Notes

- **No source-repo names** in this ADR or any committed content, per the repo's
  English-only, no-external-naming rule (see ADR 0081 Notes). The per-runner
  enforcement flags and the schema shape are documented by capability, not by
  origin.
- **`should_fully_stop` vs. `success`.** These are orthogonal: an attempt can
  succeed on its slice (`success: true`) while there is still more queue to drain
  (`should_fully_stop: false`), or fail its slice (`success: false`) while
  signalling the outer loop to stop (`should_fully_stop: true`). The mapping to
  the three sentinel states (`DONE` / `BLOCKED` / `NO MORE TASKS`) is defined in
  Decision §1.
