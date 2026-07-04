# Command topology — `/goal` (directive) → `/go` (demand) → `/afk` (backlog); `/ship` retired as gate-as-stage

## Status

Accepted. Implements the dispatch architecture locked in PRD #928. Records the structured decision on the `/goal`→`/go`→`/afk` spectrum, `/ship` retirement, and the validation pipeline as a shared internal gate stage.

## Context

The dispatch surface had three clarity issues:

1. **`/ship` is an orphan.** It assumes work is already committed and only does PR→monitor→merge. The trigger is unclear: "I never know when to call it." A command whose purpose is fuzzy is maintenance debt.

2. **There is a gap between unstructured and fully structured work.** `/goal` is unstructured (a directive I keep green). `/afk` is fully structured (PRD → issues → triage). Between them, a user cannot dispatch a *concrete, single demand* — "go do this specific thing and bring me a clean PR" — without authoring a PRD and triaging issues.

3. **The validation pipeline is opaque.** Today, a PR can be created by `/ship`, opened to review, merged, closed — each step is a separate command. The same review→test→lint→PR→CI line is trusted for `/afk` work but hidden from manual work.

Together, these create dead weight (`/ship`), an underserved middle ground, and a validation step that feels ad-hoc rather than shared.

## Decision

### 1. Dispatch spectrum: `/goal` → `/go` → `/afk`

Define a three-tier dispatch hierarchy:

- **`/goal` — unstructured directive.** A maintainer issues an imperative that will be kept green through session context. No artifact (issue, PR, queue) is created; the work is purely conversational. Example: "help me debug this test failure." Existing behaviour, unchanged.

- **`/go` — concrete demand.** A semi-structured front door: `/go "<demand>"` auto-mints a disposable tracking issue in an isolated lane (out of `ready-for-agent`), spins a dedicated, namespaced worker (`.red/tmp/go-workers/…`, separate from `/afk`'s `.red/tmp/workers/`), does the work in an isolated worktree, runs it through the shared validation gate, and brings back a PR. The disposable issue auto-closes on merge. `/go` reuses the entire AFK engine (worker, supervisor-of-one, monitor, worktree, heartbeat, envelope, reconcile) — it is not a parallel path.

- **`/afk` — structured backlog.** A fully staged system: author PRD → triage to issues → assign labels → workers drain `ready-for-agent`. Multiple workers run in parallel. This tier is unchanged in topology; it gains the gate-as-stage contract and the shared validation logic (as detailed in Decision 3 below).

### 2. `/ship` is retired; there is no standalone gate command

`/ship` is removed as a command entirely. Its roles are subsumed:

- **Manual work + gating:** When a maintainer has done the work by hand, a *requeue* action (not `/ship`) adopts the existing branch and routes it through the shared validation gate via the existing no-agent landing lane (ADR 0055 reconcile). There is no interactive `/gate` or `/ship` replacement — requeue is an action on an issue, not a top-level command.

- **PR review + merge:** The validation gate (defined in Decision 3) is an internal stage reached by `/go` and `/afk` automatically. It is not a user-facing command. A user never types `/gate` or `/ship`; these are implementation details of the dispatch tiers.

**Why:** The maintainer's diagnosis was "I never know when to call `/ship`." Redocumenting it or renaming it would not fix the orphanhood. Dissolving it into an internal stage that the tiers invoke removes the decision burden entirely.

**Alternatives considered:**

- *Rename `/ship` to `/gate`.* Rejected — the maintainer explicitly chose to route hand-done work through requeue, not a manual gate command. A `/gate` command would recreate the same "when do I call it?" question.

- *Keep `/ship` and document when to use it.* Rejected — a fuzzy trigger should be removed, not documented.

### 3. Validation pipeline as a shared internal gate stage

The review→test→lint→PR→CI line becomes a **shared internal stage** reached three ways:

1. **Automatically by `/go`.** When `/go` finishes a worker iteration, the gate runs; if green, the PR is created and ready for review; if red (intent issues, not formatting), the user pauses to review findings and decide (approve/fix/skip). The gate uses one logic; context-aware escalation differs by presence: interactive `/go` → pause and ask; headless `/afk` → park to `ready-for-human`.

2. **Automatically by `/afk`.** When an `/afk` worker finishes an iteration, the gate runs; if green, the PR is created; if red, the worker is parked to `ready-for-human` for a human decision.

3. **Manually by requeue.** When a maintainer has already done the work on their own branch, they requeue into the no-agent landing lane (ADR 0055). The branch is adopted and validated gate-only — no re-implementation, no agent re-run — through the same feedback gate authority `runFeedback` uses.

**Mechanical vs. intent:** The gate distinguishes two classes of findings:

- **Mechanical** (auto-apply, always commit): formatter, import organizer, lint --fix, comment typo, trailing whitespace, trailing newline. These are defined by a closed, auditable allowlist. **Default: intent.**

- **Intent** (require human decision): any finding not on the mechanical list. Examples: a function rename (intent to change behaviour), a test expectation change (intent to change spec), a library upgrade (intent to change dependency).

**Escalation context:** When a gate finding is intent:

- In `/go` (interactive): the worker pauses and asks the maintainer to approve, fix, or skip. The maintainer is present and the one-shot feel is preserved.

- In `/afk` (headless): the worker is parked to `ready-for-human` with `blocked:validation` and a comment carrying the findings. The HITL path that already exists handles review and next steps.

**Green gate:** All findings are mechanical (auto-applied) or approved. The PR is created, pushed, and passes CI. The worker proceeds to merge via the existing `doLanding` path (ADRs 0030/0031).

**Red gate:** An unapproved intent finding blocks the landing. In `/go`, the user decides. In `/afk`, the issue parks. The maintained-by-existing-HITL path handles resolution.

### 4. Gate authority and worktree

The gate runs in an isolated feedback worktree (`makeFeedbackWorktree`, ADR 0008, already trusted by `/afk`). It invokes the existing `runFeedback` authority used by the trust gate and the `timeout` reconcile path (ADR 0055). Zero new judgment logic; one verdict gate is shared.

## Consequences

- `/go` becomes the interactive one-shot dispatch tier; `/afk` remains the batch/headless tier. Together with `/goal`, the three cover the full spectrum from unstructured to backlog.

- A user no longer faces the "when do I call `/ship`?" question. Manual work is handled by requeue, not a separate gate command.

- The validation pipeline (review→test→lint→PR→CI) is now explicit, shared, and auditable. All work — `/go`, `/afk`, hand-done-and-requeued — passes through the same gate.

- Mechanical findings auto-apply and auto-commit across all three tiers. Intent findings are escalated contextually: pause-and-ask in interactive `/go`, park-to-HITL in headless `/afk`.

- Worktrees are spawned for both `/go` and `/afk`, with isolated namespacing (`go-workers/` vs. `workers/`) preventing collision. Both tiers gain the worktree manager benefits (submodule-init, `node_modules` linking, orphan recovery, mid-run-deletion recovery).

- The no-agent landing lane (ADR 0055 reconcile) becomes the home for hand-done work, called via requeue. The same `doLanding` path lands all work — no new merge logic.

- A new `origin` field on every worker (enum: `afk | go | urgent | …`) allows statusline and monitor to show per-source counts that never diverge. Both surfaces read the same authoritative field; no render-time inference.

## Related

- ADR 0055 — the no-agent reconcile lane that requeue adopts for hand-done work.
- ADR 0008 — the feedback gate worktree and `runFeedback` authority, shared by the validation pipeline.
- ADR 0030/0031 — the `doLanding` path, reused by `/go`, `/afk`, and requeue.
- ADR 0028 — the structured-output contract (a sibling ADR, addresses the `/afk` completion signal with a validated `AgentOutput` schema instead of the fragile text sentinel).
- PRD #928 — the full dispatch architecture, including the `/go` implementation details, worktree manager, event-driven supervision, TOON output, and browser collaboration.
- Issue #332 — `no-sentinel`-with-commits salvage, a prior precedent for the no-agent landing lane.

## Notes

- **`/ship` code path:** `commands/ship.ts` and `core/ship.ts` are deprecated and aliased to requeue for backwards compatibility during rollout; the manual path routes through `commands/requeue.ts` → `reconcile.ts` → `landing.ts`.

- **Mechanical allowlist is closed.** Future changes to the list require an ADR amendment, not a config file. This ensures the safety rule (intent changes never auto-land) stays auditable.

- **No source-repo names** in the ADR or committed content. The absorbed components (dispatch tier design, worktree manager concept, gate-as-stage philosophy) retain their origins in the grilling session, not in naming.

## Amendment 1 — `/go` Definition-of-Done gate (guaranteed termination)

### Status

Accepted. Extends Decisions 2–4 with a mandatory stop-condition gate for `/go`. Records the decision reached in a `/start` grilling session.

### Context

The base ADR gave `/go` the AFK engine's completion contract: the inner agent self-declares done by emitting the completion signal. In practice a `/go` dispatch could **never converge** — the agent kept committing "improvements" against a vague demand, and because every commit resets the commit-anchored progress guard (ADR 0044/0045), this **productive loop** survived all existing termination bounds (`idleTimeout`, `maxIterations`, the commit guard). The root cause is structural: `/go` accepted a demand with **no explicit stop condition**, leaving the agent as the sole judge of "done."

The failure is most acute in a repo with **no `afk.backpressure` / feedback gate configured**: there is no machine gate at all, so the DONE contract is purely the agent's judgment — the exact conditions under which the loop was observed.

### Decision

1. **Mandatory pre-dispatch Definition-of-Done gate.** `/go` no longer dispatches on the first turn. The skill first drafts, in the conversational layer — before any worktree exists — a **Task** (the demand rewritten in high detail) and a **Definition of Done**, and asks the maintainer to approve. Only after approval does the worker/worktree spin up. The gate is **always required**: `+yolo` stays an in-run autonomy bump and never skips it; `--dod "<condition>"` pre-fills the confirmation (sugar) but never skips it.

2. **Definition of Done is hybrid.** Two halves:
   - **Semantic** — a per-demand acceptance statement ("what I actually asked for"), recorded on the disposable `lane:go` issue and injected into the handoff.
   - **Machine gate** — reuses the repo's **already-configured harness/backpressure** (`afk.backpressure` plus the auto-derived `test`/`typecheck`/`lint`/`build` feedback gate), not a per-demand invented command. This is already wired into the `<merge-gate>` handoff section and the pre-`DONE` contract, so `/go` inherits it with no new execution logic.

3. **Guaranteed termination.** When the machine gate fails after `DONE`, the run enters a **bounded** correct-and-re-verify cycle (a small cap, distinct from `maxIterations`). On exhausting the cap with the gate still red, the run **stops deterministically** and escalates to `ready-for-human` / `blocked:validation`, carrying the partial diff and the failing gate's output tail — never an unbounded retry. The productive loop becomes a bounded, always-terminating run with a clear signal.

4. **No-harness fallback.** When the target repo has no configured harness/backpressure, the confirm gate **detects the absence at approval time** and offers to add an **ephemeral inline check** (a shell command that must exit 0, run as backpressure for that single dispatch only). If the maintainer declines, `/go` proceeds **best-effort under a tightened iteration cap** (well below the default 12) so a check-less demand fails fast to a human instead of looping. The configured harness stays the primary source; the inline check is only the net.

5. **Isolation unchanged.** Everything that executes still runs in the isolated worktree under `.red/tmp/go-workers/` against the worker-branch checkout, never the primary (Decision 4). The confirm gate is the only new step, and it runs purely in conversation before the worktree exists; the machine gate runs where AFK backpressure already runs.

### Consequences

- A `/go` demand can no longer loop indefinitely: it either satisfies the configured (or inline) gate, or it terminates and escalates with a concrete reason.
- The maintainer sees and approves the stop condition **before** any tokens are spent — "when will it stop?" is answered up front, not discovered mid-run.
- Repos are nudged to declare `afk.backpressure` once; where they have not, `/go` surfaces the gap at confirm time instead of silently degrading to an agent-judged loop.
- No new execution path: the machine gate, worktree, and landing all reuse existing AFK authority; only the pre-dispatch confirmation and the bounded re-verify cap are new.

### Related

- ADR 0044/0045 — the commit-anchored progress guard the productive loop defeated.
- ADR 0008 — the feedback-gate `runFeedback` authority reused as the machine gate.
- `afk.backpressure` (AFK `docs/CONFIG.md`, PRD #429/#430) — the operator-declared merge gate that becomes the DoD's machine half.
