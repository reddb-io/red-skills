# Task-Executor Phase Contract (runner-neutral)

The task-executor is the second of the five AFK phases defined by [`afk-task.md`](./afk-task.md). It consumes the existing `/afk` issue + handoff artefacts (optionally guided by an [`issue-analyzer`](./issue-analyzer.md) envelope, when one was produced) and performs the scoped implementation work in the worktree — and only that. It does not run quality gates, does not commit, and does not merge.

This document is the canonical source for that phase. The JSON Schema lives next door at [`task-executor.schema.json`](./task-executor.schema.json) and the structural validator at [`../../scripts/validate-task-executor-contract.sh`](../../scripts/validate-task-executor-contract.sh).

## Status of this contract

This issue (#200) lands the **schema, fixtures, and structural validator only**. It does not yet rewire `/afk` to invoke the task-executor or to consume its envelope — that is the job of the downstream slices in PRD #196. Until those land, the orchestrator continues to use the `<promise>DONE</promise>` / `<promise>BLOCKED</promise>` sentinels exactly as today. Compatibility is preserved by construction: nothing in this slice changes the inner-agent prompt or the orchestrator's parsing.

## Inputs

The task-executor consumes only the artefacts `/afk` already builds, plus any analyzer envelope from the same attempt:

- **Issue body** — the `<issue-body>` element of the handoff, including the `## Agent brief`, `## Acceptance`, `## Refs`, `## Suggested Skills`, and `## Blocked by` sections.
- **Previous attempts** — the `<previous-attempts>` element, if present.
- **Human guidance thread** — the `<human-guidance>` elements, in chronological order. The most recent overrides older guidance and overrides the brief.
- **Thread discussion** — advisory only; consulted only to disambiguate.
- **Issue-analyzer envelope (optional)** — when the analyzer ran first in the same attempt, the executor SHOULD inherit `analysis.scope_boundaries`, `analysis.acceptance_criteria_map`, and `analysis.verification_expectations` as the authoritative fences. When no analyzer envelope is available (basic runners, fallback), the executor derives the same fences from the issue body directly.
- **Repo `.red/` context** — `CONTEXT.md`, `adr/`, `wiki/` (when present). Read-only.
- **Worktree** — the isolated git worktree the orchestrator already provisions.

The executor **must not** introduce a new "docs" or "plans" or "tasks" queue. The GitHub issue + handoff is the queue; the executor only reads what is already there and writes worktree files.

## Output

The output is the base AFK envelope from [`afk-task.md`](./afk-task.md) with `phase` pinned to `execute_task` and one additional required object: `execution`. The base envelope carries the cross-phase fields (`status`, `scope_summary`, `non_goals`, `acceptance_criteria_results`, `changed_files`, etc.); `execution` carries the executor-specific structured fields.

Because quality gates and commits are owned by later phases ([`verify_task`](./afk-task.md), `fix_or_escalate`, `finalize`), the analyze-phase-style invariants are repeated here for the execute phase:

- `verification_commands` MUST be `[]`.
- `verification_results` MUST be `[]`.
- `quality_gate_failures` MUST be `[]`.
- Every entry in `acceptance_criteria_results` MUST have `result: unverified`. The executor mirrors the brief's checklist and points to the change it made; it never self-grades pass/fail because it has not run the gates.

`changed_files` is the executor's primary output:

- When `status` is `completed`, `changed_files` MUST be non-empty. A "completed" executor envelope that touched no files is hollow by construction.
- When `status` is `blocked` or `escalation_needed`, `changed_files` MAY be empty (the executor stopped before making changes) or non-empty (the executor made partial changes and stopped). Either is valid; downstream phases decide what to keep.

The hollow-success rule from [`afk-task.md`](./afk-task.md) is repeated here with one execute-phase adjustment: the unverified-result branch is intentionally exempt for the execute phase (the executor always emits unverified results), but the quality-gate-failures branch still applies, and the **empty-changed_files-on-completed** branch is added.

### The `execution` object

| Field | Type | Notes |
| --- | --- | --- |
| `implementation_summary` | string | One paragraph describing the slice the executor implemented. Non-empty. |
| `changes_by_criterion` | array of `{criterion, files_touched, approach, status}` | One entry per `## Acceptance` checkbox. `files_touched` is a subset of the envelope `changed_files`; `approach` is one sentence; `status` is `implemented` / `partial` / `deferred`. |
| `out_of_scope_rejections` | array of `{requested_change, reason}` | Edits the executor explicitly declined as out-of-scope. Empty array when nothing was rejected. |
| `non_goals_preserved` | array of strings | Concrete non-goals the executor honoured (mirrors or refines the envelope `non_goals`). |
| `commit_hint` | `{subject, body}` or null | Optional commit message the `finalize` phase MAY use. `subject` is one line; `body` is multi-line. Null is valid when the executor has no recommendation. |
| `escalation_triggers` | array of strings | Reasons the executor would have escalated had it not been able to complete (`scope_too_large`, `missing_dependency`, `contradictory_brief`, `out_of_scope_request_unavoidable`, etc.). Free-form strings; the orchestrator does not interpret them yet. |
| `follow_ups` | array of strings | Follow-up items the executor noticed but deliberately left for later iterations. Empty array is valid. |

The base envelope's `non_goals`, `scope_summary`, and `acceptance_criteria_results` remain authoritative — `execution.non_goals_preserved` is the executor's confirmation that those non-goals were honoured, and `execution.changes_by_criterion` is the executable mapping alongside the mirrored `acceptance_criteria_results` checklist.

### Status semantics for `execute_task`

- `completed` — the executor implemented every acceptance criterion (each `changes_by_criterion[*].status` is `implemented`), `changed_files` is non-empty, `out_of_scope_rejections` is empty (any out-of-scope ask either had to be honoured under guidance, in which case `status` is `escalation_needed`, or the executor refused and continued — in which case `status` is `completed` and the rejection is recorded).
- `blocked` — the executor cannot proceed (missing reference, contradictory brief that no human guidance resolves, repeated test failures, broken `## Refs`). `blocker_reason` and `next_human_action` are required by the base schema.
- `escalation_needed` — the executor believes the issue should be re-routed (wrong runner, wrong model, requires human judgement, scope too large for one slice, an out-of-scope request that cannot be safely declined). `next_human_action` is required.

### Scope rules (binding)

The executor enforces the following at write time, regardless of what the inner agent's free-form output says:

1. **No commit, no merge.** The executor must not invoke `git commit`, `git merge`, `git push`, `git rebase`, `git reset`, or any rewrite. The `finalize` phase owns commit; the orchestrator owns merge. An executor that committed despite this rule MUST be flagged by downstream tooling.
2. **No quality gates.** The executor must not run `pnpm test`, `pnpm lint`, `pnpm typecheck`, or `pnpm build` as part of its envelope. Those belong to the `verify_task` phase. The schema enforces empty `verification_commands` / `verification_results` / `quality_gate_failures` to make this auditable.
3. **No out-of-scope writes.** Files outside the analyzer's `scope_boundaries` (or, in their absence, the area implied by the brief and `## Refs`) MUST be either left untouched or recorded under `execution.out_of_scope_rejections`. The executor never writes adjacent refactors "while it's there".
4. **No new queues.** The executor MUST NOT create a parallel "plans" / "docs" / "tasks" tracker. The issue + handoff is the queue.

### When to escalate vs block

- **Escalate** when the executor is *capable* of proceeding but should not — wrong runner for the task, model too small, capability gap, scope clearly too large for one slice, or a human directive arrived asking for a change the executor judges adversarial to the brief.
- **Block** when the executor *cannot* proceed — contradictory brief unresolved by guidance, missing reference file, repeated identical test failure (≥3 cycles), broken `## Refs`.
- A completed executor envelope NEVER carries a non-empty `escalation_triggers` *plus* `status: completed`. If the executor lists triggers, it must either have actually escalated/blocked, or the triggers are documenting *avoided* escalations (rare; reserved for future tooling and ignored today).

## Deterministic shape

The envelope MUST be emittable as one JSON object that a downstream shell script or orchestrator prompt can parse with `jq -e` and no string post-processing. Concretely:

- All required keys are present (use `null` for nullable strings, `[]` for empty arrays).
- Field order is not significant, but the schema is closed (`additionalProperties: false` at both the envelope and the `execution` object). New fields require a schema bump.
- The envelope is the **only** structured output of the phase. Free-form runner chatter must not be interleaved inside the JSON block.

For Claude Code packaging, the agent SHOULD emit the envelope as the final assistant message wrapped in a single fenced ` ```json ` block, matching the convention in [`afk-task.md`](./afk-task.md).

## How each runner emits the contract

Per [`.red/research/197-claude-code-surfaces.md`](../research/197-claude-code-surfaces.md) and [`.red/research/204-codex-cli-surfaces.md`](../research/204-codex-cli-surfaces.md), the runners differ in *how* they emit the contract but not in *what* the contract contains.

### Claude Code (full)

- Packaged as the `task-executor` markdown sub-agent under `plugins/dev/agents/task-executor.md` (added by a downstream slice in PRD #196; **not** added by this issue).
- Sub-agent metadata follows the conventions enforced by [`scripts/validate-agent-metadata.sh`](../../scripts/validate-agent-metadata.sh) (issue #198): non-empty `description:`, only known frontmatter keys.
- The agent returns the envelope as its final assistant message in a fenced ` ```json ` block. The orchestrator extracts and validates it with `scripts/validate-task-executor-contract.sh`.
- `runner` field is `claude`. `raw_runner_output_path` points at the captured `stream-json` log.

### Claude Code (basic / `claude -p`)

- Same envelope, but the executor prompt is inlined into the main `/afk` session when Task-tool dispatch is unavailable. Compatibility is preserved by treating the basic harness as a degraded full harness — the contract does not change.

### Codex CLI

- No native sub-agent delegation today (#204 §1). The executor is inlined as one phase inside a single `codex exec` session and emitted as one fenced JSON block in the final assistant message.
- The orchestrator parses it out of `--output-last-message` and validates it.
- `runner` field is `codex`. **Public copy must not call this a "Codex sub-agent"** until #204's recommendation is revisited.

### Hermes / fallback

- Emits the envelope inline in its final message, same fenced JSON shape as Codex.
- `runner` field is `hermes`. Downstream consumers must treat a missing execute_task envelope as "not attempted", not as "failed".

### Orchestrator (`/afk`) compatibility

Until the downstream PRD #196 slices land, the orchestrator does **not** invoke the task-executor and does **not** require its envelope. The `<promise>DONE</promise>` / `<promise>BLOCKED</promise>` sentinels remain the lifecycle signal. The contract is additive: a runner that produces the executor envelope gets richer audit; a runner that does not still completes its issue. This satisfies the "existing `/afk` behavior remains compatible when a runner does not support native agents/subagents" acceptance criterion from PRD #196.

## Fixtures

Fixtures live under [`fixtures/task-executor/`](./fixtures/task-executor/):

- `valid/normal-implementation.json` — a normal AFK issue: `status: completed`, every acceptance criterion mapped to `changes_by_criterion[*].status: implemented`, `changed_files` non-empty, `out_of_scope_rejections: []`, `commit_hint` populated.
- `valid/blocked-out-of-scope.json` — executor stops because a human guidance comment asked it to touch files outside the analyzer's scope and the executor refused: `status: escalation_needed`, `out_of_scope_rejections` populated, `next_human_action` set, partial `changed_files` allowed.
- `invalid/missing-execution.json` — well-formed base envelope but no `execution` object. Validator rejects.
- `invalid/malformed-json.json` — not valid JSON. Validator rejects on parse.
- `invalid/completed-without-changes.json` — `status: completed` with `changed_files: []`. Violates the execute-phase hollow-completion rule. Validator rejects.

Each fixture is consumed by [`scripts/test-validate-task-executor-contract.sh`](../../scripts/test-validate-task-executor-contract.sh), which is wired into `red-release.yml` alongside the existing agent-metadata, afk-task, and issue-analyzer contract fixture tests.

## Why this contract is documentation-only today

The PRD #196 breakdown deliberately separates phase shape from production. Landing the executor schema and validator first means the production slices (sub-agent wiring, orchestrator consumption, commit handoff) can write tests against fixtures from day one, and any drift between Claude/Codex/Hermes executor implementations is caught at the contract boundary instead of in the orchestrator. The decision to inline the executor on Codex (per [`204-codex-cli-surfaces.md`](../research/204-codex-cli-surfaces.md) §4, Option C) is the load-bearing reason the contract — not the file layout — is what makes runners interchangeable.
