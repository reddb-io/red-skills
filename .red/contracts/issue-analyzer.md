# Issue-Analyzer Phase Contract (runner-neutral)

The issue-analyzer is the first of the five AFK phases defined by [`afk-task.md`](./afk-task.md). It reads an AFK issue plus its handoff context and emits a structured analysis envelope that downstream phases (`execute_task`, `verify_task`, `fix_or_escalate`, `finalize`) and the `/afk` orchestrator can consume.

This document is the canonical source for that phase. The JSON Schema lives next door at [`issue-analyzer.schema.json`](./issue-analyzer.schema.json) and the structural validator at [`../../scripts/validate-issue-analyzer-contract.sh`](../../scripts/validate-issue-analyzer-contract.sh).

## Status of this contract

This issue (#199) lands the **schema, fixtures, and structural validator only**. It does not yet rewire `/afk` to invoke the issue-analyzer or to consume its envelope — that is the job of the downstream slices in PRD #196. Until those land, the orchestrator continues to use the `<promise>DONE</promise>` / `<promise>BLOCKED</promise>` sentinels exactly as today. Compatibility is preserved by construction: nothing in this slice changes the inner-agent prompt or the orchestrator's parsing.

## Inputs

The issue-analyzer consumes only the same artefacts `/afk` already builds:

- **Issue body** — the `<issue-body>` element of the handoff, including the `## Agent brief`, `## Acceptance`, `## Refs`, `## Suggested Skills`, and `## Blocked by` sections.
- **Previous attempts** — the `<previous-attempts>` element, if present.
- **Human guidance thread** — the `<human-guidance>` elements, in chronological order. The most recent overrides older guidance and overrides the brief.
- **Thread discussion** — advisory only; consulted only to disambiguate.
- **Recent commits on `main`** — passed to the runner as context, identical to the inner-agent prompt today.
- **Repo `.red/` context** — `CONTEXT.md`, `adr/`, `wiki/` (when present). Read-only.

The analyzer **must not** introduce a new "docs" or "plans" or "tasks" queue. The GitHub issue + handoff is the queue; the analyzer only reads what is already there.

## Output

The output is the base AFK envelope from [`afk-task.md`](./afk-task.md) with `phase` pinned to `analyze_issue` and one additional required object: `analysis`. The base envelope carries the cross-phase fields (`status`, `scope_summary`, `non_goals`, `acceptance_criteria_results`, etc.); `analysis` carries the analyzer-specific structured fields.

Because no code or quality gates have been executed yet at this phase:

- `changed_files` MUST be `[]`.
- `verification_commands` MUST be `[]`.
- `verification_results` MUST be `[]`.
- `quality_gate_failures` MUST be `[]`.
- Every entry in `acceptance_criteria_results` MUST have `result: unverified`. The analyzer's job is to mirror the brief's checklist, not to grade it.

The hollow-success rule from [`afk-task.md`](./afk-task.md) therefore implies that a valid analyze_issue envelope with `status: completed` is impossible to satisfy through the existing detector if it carries unverified acceptance results — so the analyzer-specific validator exempts the analyze_issue phase from the unverified-result branch of the hollow-success rule. The completed quality-gate-failures branch still applies (a completed analysis with quality-gate failures is still hollow).

### The `analysis` object

| Field | Type | Notes |
| --- | --- | --- |
| `task_type` | enum `feature` / `bug_fix` / `refactor` / `docs` / `chore` / `test` / `contract` / `infra` / `unknown` | Classifies the work the issue asks for. `unknown` is only valid when `status` is `escalation_needed` or `blocked`. |
| `affected_area` | string | Short human-readable identifier for the surface the change touches (e.g. `plugins/dev/skills/engineering/afk`, `scripts/`, `.red/contracts/`). Non-empty. |
| `recommended_skills` | array of strings | Skill slugs the executor should preload (e.g. `tdd`, `diagnose`, `write-a-skill`). Empty array is valid. |
| `risk_level` | enum `low` / `medium` / `high` | Self-assessed impact radius. `high` should trigger extra scrutiny downstream. |
| `scope_boundaries` | array of strings | Concrete fences ("only files under `scripts/`", "do not edit `marketplace.json`"). Required, non-empty. |
| `acceptance_criteria_map` | array of `{criterion, plan, verification}` | One entry per `## Acceptance` checkbox. `plan` is one sentence on how to satisfy it; `verification` is one sentence on how to prove it. |
| `verification_expectations` | array of strings | Concrete commands or observations the executor and the quality-gate phase should run (e.g. `scripts/test-validate-issue-analyzer-contract.sh`, `pnpm test`). |
| `open_questions` | array of strings | Unresolved questions for a human. Empty array when the analysis is unambiguous. When non-empty, `status` SHOULD be `escalation_needed` or `blocked`. |
| `ambiguity_score` | enum `low` / `medium` / `high` | Self-rated ambiguity. `high` MUST coexist with a non-empty `open_questions` and `status` in {`escalation_needed`, `blocked`}. |

The base envelope's `non_goals`, `scope_summary`, and `acceptance_criteria_results` remain authoritative — `analysis.scope_boundaries` is the **enforceable** subset of `scope_summary` in command form, and `analysis.acceptance_criteria_map` is the executable plan alongside the mirrored `acceptance_criteria_results` checklist.

### Status semantics for `analyze_issue`

- `completed` — the analysis is unambiguous, scope is clear, and the executor can begin. `open_questions` is `[]`, `ambiguity_score` is `low` or `medium`.
- `blocked` — the analyzer cannot proceed (missing reference, contradictory brief that no human guidance resolves, broken `## Refs`). `blocker_reason` and `next_human_action` are required by the base schema; `open_questions` SHOULD list the specific unknowns.
- `escalation_needed` — the analysis is possible but the issue should be re-routed (wrong runner, wrong model, requires human judgement, scope too large for one slice). `next_human_action` is required.

## Deterministic shape

The envelope MUST be emittable as one JSON object that a downstream shell script or orchestrator prompt can parse with `jq -e` and no string post-processing. Concretely:

- All required keys are present (use `null` for nullable strings, `[]` for empty arrays).
- Field order is not significant, but the schema is closed (`additionalProperties: false` at both the envelope and the `analysis` object). New fields require a schema bump.
- The envelope is the **only** structured output of the phase. Free-form runner chatter must not be interleaved inside the JSON block.

For Claude Code packaging, the agent SHOULD emit the envelope as the final assistant message wrapped in a single fenced ` ```json ` block, matching the convention in [`afk-task.md`](./afk-task.md).

## How each runner emits the contract

Per [`.red/research/197-claude-code-surfaces.md`](../research/197-claude-code-surfaces.md) and [`.red/research/204-codex-cli-surfaces.md`](../research/204-codex-cli-surfaces.md), the runners differ in *how* they emit the contract but not in *what* the contract contains.

### Claude Code (full)

- Packaged as the `issue-analyzer` markdown sub-agent under `plugins/dev/agents/issue-analyzer.md` (added by a downstream slice in PRD #196; **not** added by this issue).
- Sub-agent metadata follows the conventions enforced by [`scripts/validate-agent-metadata.sh`](../../scripts/validate-agent-metadata.sh) (issue #198): non-empty `description:`, only known frontmatter keys.
- The agent returns the envelope as its final assistant message in a fenced ` ```json ` block. The orchestrator extracts and validates it with `scripts/validate-issue-analyzer-contract.sh`.
- `runner` field is `claude`. `raw_runner_output_path` points at the captured `stream-json` log.

### Claude Code (basic / `claude -p`)

- Same envelope, but the analyzer prompt is inlined into the main `/afk` session when Task-tool dispatch is unavailable. Compatibility is preserved by treating the basic harness as a degraded full harness — the contract does not change.

### Codex CLI

- No native sub-agent delegation today (#204 §1). The analyzer is inlined as one phase inside a single `codex exec` session and emitted as one fenced JSON block in the final assistant message.
- The orchestrator parses it out of `--output-last-message` and validates it.
- `runner` field is `codex`. **Public copy must not call this a "Codex sub-agent"** until #204's recommendation is revisited.

### Hermes / fallback

- Emits the envelope inline in its final message, same fenced JSON shape as Codex.
- `runner` field is `hermes`. Downstream consumers must treat a missing analyze_issue envelope as "not attempted", not as "failed".

### Orchestrator (`/afk`) compatibility

Until the downstream PRD #196 slices land, the orchestrator does **not** invoke the issue-analyzer and does **not** require its envelope. The `<promise>DONE</promise>` / `<promise>BLOCKED</promise>` sentinels remain the lifecycle signal. The contract is additive: a runner that produces the analyzer envelope gets richer audit; a runner that does not still completes its issue. This satisfies the "implementation does not change `/afk` runtime behavior yet" acceptance criterion.

## Fixtures

Fixtures live under [`fixtures/issue-analyzer/`](./fixtures/issue-analyzer/):

- `valid/normal-feature.json` — a normal AFK issue (the present issue, #199): unambiguous, `status: completed`, every acceptance criterion mirrored with `result: unverified` and a one-sentence plan + verification, `open_questions: []`, `ambiguity_score: low`.
- `valid/escalation-ambiguous.json` — an ambiguous issue the analyzer wants to re-route: `status: escalation_needed`, `ambiguity_score: high`, multiple `open_questions`, `next_human_action` set.
- `invalid/missing-analysis.json` — well-formed base envelope but no `analysis` object. Validator rejects.
- `invalid/unverified-but-completed.json` — `status: completed` with `acceptance_criteria_results[*].result: pass`, which violates the analyze-phase invariant that the analyzer never grades. Validator rejects.
- `invalid/ambiguity-without-questions.json` — `ambiguity_score: high` with `status: completed` and `open_questions: []`. Violates the cross-field consistency rule.

Each fixture is consumed by [`scripts/test-validate-issue-analyzer-contract.sh`](../../scripts/test-validate-issue-analyzer-contract.sh), which is wired into `red-release.yml` alongside the existing agent-metadata and afk-task contract fixture tests.

## Why this contract is documentation-only today

The PRD #196 breakdown deliberately separates phase shape from production. Landing the analyzer schema and validator first means the production slices (sub-agent wiring, orchestrator consumption) can write tests against fixtures from day one, and any drift between Claude/Codex/Hermes analyzer implementations is caught at the contract boundary instead of in the orchestrator. The decision to inline the analyzer on Codex (per [`204-codex-cli-surfaces.md`](../research/204-codex-cli-surfaces.md) §4, Option C) is the load-bearing reason the contract — not the file layout — is what makes runners interchangeable.
