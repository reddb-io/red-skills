# AFK Task Contract (runner-neutral)

The AFK task contract is the runner-neutral shape that every `/afk` worker — Claude Code native sub-agents, Codex CLI inline phases, or Hermes fallback — produces and the orchestrator consumes. It is the spine of PRD #196.

This document is the canonical source. The JSON Schema lives next door at [`afk-task.schema.json`](./afk-task.schema.json) and the structural validator at [`../../scripts/validate-afk-task-contract.sh`](../../scripts/validate-afk-task-contract.sh).

## Status of this contract

This issue (#205) lands the **schema, fixtures, and structural validator only**. It does not yet rewire `/afk` to emit or consume the JSON — that is the job of #199 (`issue-analyzer`), #200 (`task-executor`), #201 (`quality-gate`) and #202 (capability dispatch). Until those land, the orchestrator continues to use the `<promise>DONE</promise>` / `<promise>BLOCKED</promise>` sentinels exactly as today. Compatibility is preserved by construction: nothing in this slice changes the inner-agent prompt or the orchestrator's parsing.

## Phases

Per the issue body, AFK is decomposed into five runner-neutral phases:

1. `analyze_issue` — turn the GitHub issue + `.red` context + previous attempts into a plan, non-goals, risk list, and an acceptance-criteria map.
2. `execute_task` — make scoped code/docs changes in the worktree.
3. `verify_task` — run repo-local quality gates (`pnpm test|typecheck|lint|build`), preferably RTK/hook-backed when noisy.
4. `fix_or_escalate` — repair failures or emit a canonical blocker/escalation report.
5. `finalize` — produce a structured `completed | blocked | escalation_needed` envelope for `/afk` lifecycle decisions.

A single attempt may emit one envelope per phase. The `finalize` envelope is the only one the orchestrator strictly requires; the rest are optional debug artefacts when a runner can produce them cheaply.

## Required fields

Every envelope (regardless of phase) MUST carry the following fields:

| Field | Type | Notes |
| --- | --- | --- |
| `status` | enum `completed` / `blocked` / `escalation_needed` | `completed` means the phase did its job. `blocked` means the agent stopped and wants a human. `escalation_needed` means the agent thinks `/afk` should re-route (different runner, different model, different skill). |
| `phase` | enum `analyze_issue` / `execute_task` / `verify_task` / `fix_or_escalate` / `finalize` | Which phase produced this envelope. |
| `runner` | enum `claude` / `codex` / `hermes` | Identifies the inner agent. Public copy must not promise a Codex value implies native sub-agents (per #204 §4). |
| `issue_number` | integer | The GitHub issue being executed. |
| `scope_summary` | string | One paragraph describing the slice the agent worked on. |
| `non_goals` | array of strings | Adjacent work the agent deliberately did **not** do. Required even when empty (use `[]`). |
| `acceptance_criteria_results` | array of `{criterion, result, evidence}` | One entry per `## Acceptance` checkbox in the issue body. `result` is `pass` / `fail` / `unverified`. `evidence` is a short string (commit SHA, file path, log excerpt). |
| `changed_files` | array of strings | Worktree-relative paths the agent modified. Empty array is valid for `analyze_issue`/`verify_task`. |
| `verification_commands` | array of strings | Commands the agent ran, exactly as invoked. Empty array is valid before `verify_task`. |
| `verification_results` | array of `{command, exit_code, summary}` | One entry per executed command. `exit_code` is an integer; `summary` is a short human-readable line. |
| `quality_gate_failures` | array of strings | Specific failures (test name, lint rule, type error). Empty array MUST be used when there are no failures — never null, never omitted. |
| `blocker_reason` | string or null | Required non-null when `status` is `blocked`. Null otherwise. |
| `next_human_action` | string or null | Required non-null when `status` is `blocked` or `escalation_needed`. One actionable sentence. |
| `remaining_risks` | array of strings | Known risks the slice did not fully eliminate. |
| `confidence` | enum `low` / `medium` / `high` | Self-reported confidence in the envelope. `low` is a hint to the orchestrator to flag the issue for human review even on `completed`. |
| `raw_runner_output_path` | string or null | Worktree- or iteration-relative path to the raw runner transcript (last-message file, stream-json log). Null when no artefact was retained. |

### Hollow-success rule (binding)

An envelope is **hollow** — and rejected by the validator — when **all** of the following hold:

- `status` is `completed`; AND
- at least one of:
  - `quality_gate_failures` is non-empty, OR
  - any `acceptance_criteria_results[*].result` is `fail` or `unverified`.

Hollow success is the failure mode the PRD is most worried about: an agent that says "done" while its own evidence shows otherwise. The validator catches the shape at write time; the orchestrator can additionally treat hollow envelopes as `escalation_needed` at consume time (out of scope for this issue).

### Malformed JSON

Anything that does not parse as JSON, or whose top-level value is not an object, fails validation with a `malformed JSON` error. This is the cheapest detector — runners that don't speak JSON natively should pipe through `jq -c .` before writing.

## How each runner consumes the contract

Per [`.red/research/197-claude-code-surfaces.md`](../research/197-claude-code-surfaces.md) and [`.red/research/204-codex-cli-surfaces.md`](../research/204-codex-cli-surfaces.md), the runners differ in *how* they emit the contract but not in *what* the contract contains.

### Claude Code (full)

- Phases map to markdown sub-agents under `plugins/dev/agents/` (`issue-analyzer.md`, `task-executor.md`, `quality-gate.md`, `blocker-reporter.md`).
- Each sub-agent returns the envelope as its final assistant message, wrapped in a fenced ` ```json ` block. The orchestrator extracts and validates it.
- `runner` field is `claude`. `raw_runner_output_path` points at the captured `stream-json` log.

### Claude Code (basic / `claude -p`)

- Same envelopes, but the inner agent inlines the four phase prompts inside one session when Task-tool dispatch is unavailable.
- Compatibility is preserved by treating the basic harness as a degraded full harness — the contract does not change.

### Codex CLI

- No native sub-agent delegation today (#204 §1). Phases are inlined into one `codex exec` session and emitted as five fenced JSON blocks in the final assistant message.
- The orchestrator parses them out of `--output-last-message` and validates each one.
- `runner` field is `codex`. **Public copy must not call Codex envelopes "sub-agent output"** until #204's recommendation is revisited.

### Hermes / fallback

- Emits the envelope inline in its final message, same fenced JSON shape as Codex.
- `runner` field is `hermes`. Downstream consumers must treat absent phases as "not attempted", not as "failed".

### Orchestrator (`/afk`) compatibility

Until #199–#202 land, the orchestrator does **not** require any envelope. The `<promise>DONE</promise>` / `<promise>BLOCKED</promise>` sentinels remain the lifecycle signal. The contract is additive: a runner that produces envelopes gets richer audit; a runner that does not still completes its issue. This satisfies the "existing `/afk` behavior remains compatible when a runner does not support native agents/subagents" acceptance criterion.

## Fixtures

Fixtures live under [`fixtures/afk-task/`](./fixtures/afk-task/):

- `valid/completed-execute.json` — happy path, `execute_task` finished, all criteria pass, no quality-gate failures.
- `valid/blocked-execute.json` — agent stopped mid-execution, blocker reason set, next human action set.
- `valid/escalation-verify.json` — `verify_task` reports an unrecoverable gate failure and asks `/afk` to escalate.
- `invalid/malformed-json.json` — not valid JSON. Validator rejects on parse.
- `invalid/missing-fields.json` — drops `non_goals` and `quality_gate_failures`. Validator rejects.
- `invalid/hollow-success.json` — `status: completed` while `quality_gate_failures` is non-empty. Validator rejects.

Each fixture is consumed by [`scripts/test-validate-afk-task-contract.sh`](../../scripts/test-validate-afk-task-contract.sh), which is wired into `red-release.yml` alongside the existing agent-metadata fixture test.

## Why this contract is documentation-only today

The PRD breakdown deliberately separates shape (#205) from production (#199–#202). Landing the schema and validator first means the downstream slices can write tests against fixtures from day one, and any drift between Claude/Codex/Hermes phase implementations is caught at the contract boundary instead of in the orchestrator. The decision to inline phases on Codex (per [`204-codex-cli-surfaces.md`](../research/204-codex-cli-surfaces.md) §4, Option C) is the load-bearing reason the contract — not the file layout — is what makes runners interchangeable.
