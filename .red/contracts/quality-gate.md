# Quality-Gate Phase Contract (runner-neutral)

The quality-gate is the third of the five AFK phases defined by [`afk-task.md`](./afk-task.md). It runs after the [`task-executor`](./task-executor.md) has finished implementing the slice and before the `finalize` phase commits / the orchestrator merges. It discovers the repo-local quality commands (`pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, plus anything declared via the repo's quality manifest), runs them — preferably wrapped by RTK or hook-backed runners when their raw output would be noisy — grades each acceptance criterion against the captured evidence, and emits a structured `approved` / `blocked` / `stub_detected` outcome.

This document is the canonical source for the phase. The JSON Schema lives next door at [`quality-gate.schema.json`](./quality-gate.schema.json) and the structural validator at [`../../scripts/validate-quality-gate-contract.sh`](../../scripts/validate-quality-gate-contract.sh).

## Status of this contract

This issue (#201) lands the **schema, fixtures, and structural validator only**. It does not yet rewire `/afk` to invoke the quality-gate or to consume its envelope — that is the job of the downstream slices in PRD #196. Until those land, the orchestrator continues to use the `<promise>DONE</promise>` / `<promise>BLOCKED</promise>` sentinels exactly as today. Compatibility is preserved by construction: nothing in this slice changes the inner-agent prompt or the orchestrator's parsing.

## Inputs

The quality-gate consumes the artefacts `/afk` already builds plus any phase envelopes from earlier phases in the same attempt:

- **Issue body** — the `<issue-body>` element of the handoff, including the `## Agent brief`, `## Acceptance`, `## Refs`, `## Suggested Skills`, and `## Blocked by` sections. The `## Acceptance` checklist is the canonical source of criteria to verify.
- **Previous attempts** — the `<previous-attempts>` element, if present. Quality-gate uses these to spot regressions across attempts.
- **Human guidance thread** — the `<human-guidance>` elements, in chronological order. The most recent overrides older guidance and overrides the brief — including overrides that relax a specific acceptance criterion (in which case the gate respects the override rather than failing the criterion).
- **Thread discussion** — advisory only.
- **Task-executor envelope (optional, expected)** — when an executor envelope is available, the gate SHOULD use its `execution.changes_by_criterion`, `execution.non_goals_preserved`, `scope_summary`, and `changed_files` as the implementation map. When no executor envelope is available (basic runners, fallback), the gate derives the same map from the issue body + the worktree diff.
- **Issue-analyzer envelope (optional)** — when an analyzer envelope is available, the gate SHOULD use `analysis.scope_boundaries` to detect scope drift and `analysis.verification_expectations` as the floor for what "meaningful verification" looks like.
- **Worktree diff** — the gate inspects the worktree (or `git diff` against the merge-base) to detect scope drift, stub patterns, and zero-test matches. Read-only.
- **Repo `.red/` context** — `CONTEXT.md`, `adr/`, `wiki/` (when present). Read-only.

The gate **must not** introduce a new "checks" or "verification" queue. The issue + handoff is the queue; the gate writes only the envelope, the captured command output (under `raw_runner_output_path`), and — when scope-permitting fixes are applied — narrow edits to files already inside scope.

## Output

The output is the base AFK envelope from [`afk-task.md`](./afk-task.md) with `phase` pinned to `verify_task` and one additional required object: `quality_gate`. The base envelope carries the cross-phase fields (`status`, `scope_summary`, `non_goals`, `acceptance_criteria_results`, `changed_files`, `verification_commands`, `verification_results`, `quality_gate_failures`, etc.); `quality_gate` carries the gate-specific structured fields.

The verify-phase invariants the schema enforces:

- `verification_commands` MAY be empty only when the repo legitimately exposes no quality commands AND no acceptance criterion mentions a behaviour that would normally be exercised by one (the analyzer's `verification_expectations`, or the brief's `## Acceptance`, define "normally"). In every other case, the gate that emits an empty `verification_commands` is hollow by construction.
- `verification_results` MUST be the same length as `verification_commands`, and `quality_gate.checks_run` MUST mirror them entry-for-entry (same command, same order).
- `acceptance_criteria_results[*].result` is `pass` / `fail` / `unverified`. The gate is the phase that grades — `unverified` here means the gate could not derive a pass/fail signal (no command exercises the criterion, manual-only check, etc.). Per the base envelope's hollow-success rule, `status: completed` with any `unverified` or `fail` result is rejected; the gate must downgrade `status` to `blocked` or `escalation_needed`.
- `quality_gate_failures` MUST be empty when `quality_gate.outcome` is `approved`, and MUST be non-empty when `quality_gate.outcome` is `blocked` AND no other blocking signal (stub finding, scope drift, unverified criterion, failed criterion) is present.
- `changed_files` reflects the worktree state at gate time. The gate MAY have applied in-scope fixes (e.g. lint-only edits inside files the executor already touched, type errors in already-touched modules), in which case `changed_files` is a superset of the executor's `changed_files`. The gate MUST NOT touch files outside the executor's scope, even to "fix lint while it's there".

### The `quality_gate` object

| Field | Type | Notes |
| --- | --- | --- |
| `outcome` | enum `approved` / `blocked` / `stub_detected` | Decision the gate is publishing for the orchestrator. See "Outcome semantics" below. |
| `checks_run` | array of `{name, command, exit_code, duration_seconds, output_summary, used_rtk}` | One entry per command actually executed, in the order they ran. Mirrors `verification_results` shape-for-shape with the extra `name` / `duration_seconds` / `used_rtk` audit fields. Empty array is valid only when `verification_commands` is also empty. |
| `discovered_commands` | array of `{name, command, reason_included, reason_skipped}` | Commands the gate considered. Every command that ran appears in `checks_run` with `reason_skipped: null`; commands the gate decided to skip (e.g. `pnpm build` absent from `package.json`, `pnpm e2e` requires a network it does not have) appear here with a non-null `reason_skipped` and do not appear in `checks_run`. Discovery is auditable. |
| `stub_findings` | array of `{kind, location, evidence}` | Each entry documents one piece of hollow evidence the gate refused to accept. `kind` ∈ {`skipped_test`, `hollow_test`, `zero_test_match`, `placeholder_implementation`}. `location` is a file path with optional `:line` suffix. `evidence` quotes the offending snippet or describes the pattern. Empty array means the gate found no stubs. |
| `scope_drift_findings` | array of `{file, reason}` | Files the executor (or the human-guidance thread) touched outside the analyzer's `scope_boundaries`. Empty array when scope was honoured. |
| `acceptance_verification` | array of `{criterion, verified, evidence_source}` | One entry per `## Acceptance` checkbox. `verified` ∈ {`by_command`, `by_artifact`, `unverifiable_in_this_phase`, `human_override`}. `evidence_source` points at the command name, file path, or guidance comment that justifies the verdict. This is the gate's audit trail behind `acceptance_criteria_results`. |
| `fixes_applied` | array of `{file, description, in_scope_justification}` | Narrow, in-scope fixes the gate applied while running checks (e.g. lint autofix on already-touched files, trivially-correct type annotation). Each entry MUST include a justification that the file is inside the executor's scope. Empty array when no fixes were applied. |
| `fixes_rejected` | array of `{requested_fix, reason}` | Fixes the gate explicitly declined — out-of-scope refactors a test failure suggested, broad upgrades a lint rule recommended, etc. Empty array when nothing was rejected. |
| `rtk_used` | boolean | True when at least one entry in `checks_run` has `used_rtk: true`. Convenience flag for orchestrator dashboards. |

`verification_results` and `quality_gate.checks_run` are intentionally redundant: the base envelope's `verification_results` keeps wire compatibility with non-gate phases that also report command runs; `checks_run` adds the gate-specific audit fields (`name`, `duration_seconds`, `used_rtk`). The validator enforces they describe the same run in the same order.

### Outcome semantics

- **`approved`** — `status` MUST be `completed`. Every `acceptance_criteria_results[*].result` MUST be `pass`. `quality_gate_failures`, `stub_findings`, and `scope_drift_findings` MUST all be empty arrays. `next_human_action` MUST be `null`. This is the green-light state: the orchestrator can hand the worktree to the `finalize` phase for commit and merge.
- **`blocked`** — `status` MUST be `blocked`. At least one of the following is true: `quality_gate_failures` is non-empty, any `acceptance_criteria_results[*].result` is `fail`, or `scope_drift_findings` is non-empty. `blocker_reason` and `next_human_action` are required by the base schema. Use this when the slice does not pass and the gate believes the issue is fixable on a re-run (different code, different brief).
- **`stub_detected`** — `status` MUST be `blocked` OR `escalation_needed`. `stub_findings` MUST be non-empty. `next_human_action` is required. Use this when the executor's claim of "done" is contradicted by the evidence (skipped tests, hollow assertions, zero-test matches, placeholder implementations). `stub_detected` is more specific than `blocked` because it explicitly flags integrity-of-evidence failures — orchestrators may treat it as a stronger signal (escalate, mark the runner suspect, downrank for follow-up attempts).

The gate MUST pick exactly one `outcome`. When multiple conditions hold (e.g. the slice has a real test failure *and* a placeholder implementation), the gate uses this priority:

1. `stub_detected` wins over `blocked` — hollow evidence is a louder failure than a real, honestly-reported one.
2. `blocked` wins over `approved` — when in doubt, do not approve.

### Stub detection (the heart of the gate)

The four `stub_findings.kind` values are concrete signals, not vibes:

| `kind` | What the gate looks for |
| --- | --- |
| `skipped_test` | A test added or modified in this slice that is marked `.skip`, `.todo`, `xit`, `xdescribe`, `it.skip`, `test.skip`, `test.todo`, `tape.skip`, or the framework's equivalent. Pre-existing skips outside the diff are out of scope. |
| `hollow_test` | A test that exercises a new behaviour and contains either zero assertions, only `expect(true).toBe(true)`-class tautologies, or asserts only on values it just hand-set. The gate either runs a lightweight AST/grep heuristic or — when wired through Claude Code — uses the inner agent's reading of the diff. |
| `zero_test_match` | A test runner reported `0 tests matched the pattern` (or framework equivalent) for a `## Acceptance` criterion the gate expected to see covered. Distinct from "tests passed": no tests *ran*. |
| `placeholder_implementation` | The diff introduces `TODO`, `FIXME`, `pass # implement me`, `throw new Error("not implemented")`, `return null  // TODO`, or another placeholder pattern in a file the executor claimed to "implement" the criterion against. |

The gate is **deliberately strict** about stubs: a `stub_finding` is more useful to file as `stub_detected` and let a human (or the next attempt) react, than to swallow it and let the executor's "done" claim slip past the gate.

### Scope drift, acceptance, and unproven criteria

Three failure modes the gate handles beyond "a command exited non-zero":

1. **Scope drift** — the executor (or, more often, a human-guidance ask that the executor honoured) touched files outside the analyzer's `scope_boundaries` (or, in their absence, outside the area implied by the brief and `## Refs`). The gate emits `scope_drift_findings` entries and, if any are present, MUST NOT mark the outcome `approved`.
2. **Unproven acceptance** — a `## Acceptance` checkbox the gate cannot tie to a passing command or a verified artefact. The gate marks the corresponding `acceptance_criteria_results[*].result` as `unverified`, records the reasoning under `acceptance_verification`, and (per the hollow-success rule) cannot publish `approved`. The acceptance criterion text "rejects unproven acceptance" maps directly to this rule.
3. **Failed acceptance** — a `## Acceptance` checkbox a command actually disproved (e.g. a test that asserts the new behaviour failed). The gate marks the result `fail`, populates `quality_gate_failures` with the specific failure, and emits `blocked`.

The gate refuses to whitewash any of these into `approved`. The validator enforces the relationship.

### When to fix vs reject (allowed fixes)

The gate MAY apply narrow, in-scope fixes that the captured failures hint at — provided every one of these is true:

- The fix is **inside** the executor's `changed_files` (or, in the absence of an executor envelope, inside the analyzer's `scope_boundaries`).
- The fix is **mechanical** — applying a lint autofix that the linter itself recommends, adding a missing type annotation the type-checker named exactly, deleting a stray unused import the static analyser pointed at. Anything that requires judgement about behaviour belongs to the executor or a new attempt.
- The fix does **not** modify test behaviour. A gate that "fixes" a test failure by editing the test has produced a `stub_finding`, not a fix.
- The fix is **logged** under `fixes_applied` with an `in_scope_justification` referencing the file's membership in the executor's scope.

Everything else MUST go into `fixes_rejected` with a one-sentence reason. "Broad refactor while we're here" is always a rejection.

### Verification commands and RTK / hook-backed wrappers

The gate prefers wrappers that compress noisy output when the raw stdout/stderr is not load-bearing for the decision:

- `rtk pnpm test`, `rtk vitest …`, `rtk tsc`, `rtk pnpm lint` — preferred when RTK is on the PATH and the gate only needs a pass/fail + summary line. The gate sets `checks_run[*].used_rtk: true` for those entries.
- `pnpm test` / `pnpm typecheck` / `pnpm lint` / `pnpm build` — raw, used when (a) RTK is not installed, or (b) the gate is investigating a specific failure and needs full output, or (c) a hook is already rewriting the command on its own.
- Other repo-local commands declared in `.red/quality.json` (when present) or in the brief — used as additional checks. The gate does **not** invent new test runners; if the repo does not expose one, that absence is itself a stub signal when the criterion expected one.

The gate's `discovered_commands` audit trail makes the wrapper choice reviewable: every command that ran is annotated with `used_rtk: true|false` so a downstream reviewer can tell whether the evidence is full-fidelity or summarised.

`pnpm test` invocations are additionally wrapped by the inner-agent prompt's `pnpm` PATH shim (`timeout ${RED_AFK_TEST_TIMEOUT_S:-300}s`) so a hung runner cannot stall the gate past the watchdog. This is enforced by the orchestrator, not by the schema, but the gate MUST surface a `124` exit code as a real failure in `verification_results` rather than silently retrying.

## Deterministic shape

The envelope MUST be emittable as one JSON object that a downstream shell script or orchestrator prompt can parse with `jq -e` and no string post-processing. Concretely:

- All required keys are present (use `null` for nullable strings, `[]` for empty arrays).
- Field order is not significant, but the schema is closed (`additionalProperties: false` at the envelope, the `quality_gate` object, and every nested object). New fields require a schema bump.
- The envelope is the **only** structured output of the phase. Free-form runner chatter must not be interleaved inside the JSON block.

For Claude Code packaging, the agent SHOULD emit the envelope as the final assistant message wrapped in a single fenced ` ```json ` block, matching the convention in [`afk-task.md`](./afk-task.md).

## How each runner emits the contract

Per [`.red/research/197-claude-code-surfaces.md`](../research/197-claude-code-surfaces.md) and [`.red/research/204-codex-cli-surfaces.md`](../research/204-codex-cli-surfaces.md), the runners differ in *how* they emit the contract but not in *what* the contract contains.

### Claude Code (full)

- Packaged as the `quality-gate` markdown sub-agent under `plugins/dev/agents/quality-gate.md` (added by a downstream slice in PRD #196; **not** added by this issue).
- Sub-agent metadata follows the conventions enforced by [`scripts/validate-agent-metadata.sh`](../../scripts/validate-agent-metadata.sh) (issue #198): non-empty `description:`, only known frontmatter keys.
- The agent returns the envelope as its final assistant message in a fenced ` ```json ` block. The orchestrator extracts and validates it with `scripts/validate-quality-gate-contract.sh`.
- `runner` field is `claude`. `raw_runner_output_path` points at the captured `stream-json` log and the captured per-check command output.

### Claude Code (basic / `claude -p`)

- Same envelope, but the gate prompt is inlined into the main `/afk` session when Task-tool dispatch is unavailable. Compatibility is preserved by treating the basic harness as a degraded full harness — the contract does not change.

### Codex CLI

- No native sub-agent delegation today (#204 §1). The gate is inlined as one phase inside a single `codex exec` session and emitted as one fenced JSON block in the final assistant message, alongside the analyzer + executor envelopes.
- The orchestrator parses it out of `--output-last-message` and validates it.
- The Codex inline gate MAY shell out to `pnpm` / `rtk` directly when its tool-use surface allows it, OR delegate to an external command parser that consumes raw command output and stamps the envelope. Either path produces the same shape.
- `runner` field is `codex`. **Public copy must not call this a "Codex sub-agent"** until #204's recommendation is revisited.

### Hermes / fallback

- Emits the envelope inline in its final message, same fenced JSON shape as Codex. Hermes-mode gates SHOULD restrict themselves to discovery + reporting (no `fixes_applied`) because the inner agent is less constrained.
- `runner` field is `hermes`. Downstream consumers must treat a missing verify_task envelope as "not attempted", not as "failed".

### Orchestrator (`/afk`) compatibility

Until the downstream PRD #196 slices land, the orchestrator does **not** invoke the quality-gate and does **not** require its envelope. The `<promise>DONE</promise>` / `<promise>BLOCKED</promise>` sentinels remain the lifecycle signal. The contract is additive: a runner that produces the gate envelope gets richer audit and the `approved` / `blocked` / `stub_detected` outcome to drive merge decisions; a runner that does not still completes its issue. This satisfies the "existing `/afk` behavior remains compatible when a runner does not support native agents/subagents" acceptance criterion from PRD #196.

## Fixtures

Fixtures live under [`fixtures/quality-gate/`](./fixtures/quality-gate/):

- `valid/approved-normal.json` — every check passed, every acceptance criterion graded `pass`, no stubs, no drift; `outcome: approved`, `status: completed`.
- `valid/blocked-test-failure.json` — `pnpm test` failed with a real assertion error, one acceptance criterion graded `fail`, `quality_gate_failures` populated; `outcome: blocked`, `status: blocked`.
- `valid/stub-detected-skipped-test.json` — the slice added a `.skip`-flagged test for the new behaviour; `stub_findings` populated; `outcome: stub_detected`, `status: blocked`.
- `valid/stub-detected-scope-drift.json` — the gate found edits outside the executor's scope and emitted `scope_drift_findings`; `outcome: blocked`, `status: blocked` (scope drift alone, no stubs).
- `invalid/missing-quality-gate.json` — well-formed base envelope but no `quality_gate` object. Validator rejects.
- `invalid/malformed-json.json` — not valid JSON. Validator rejects on parse.
- `invalid/approved-with-failure.json` — `outcome: approved` while `quality_gate_failures` is non-empty. Validator rejects.
- `invalid/approved-with-unverified.json` — `outcome: approved` while at least one acceptance criterion is `unverified`. Validator rejects (hollow-success rule + the outcome=approved invariant).
- `invalid/checks-mismatch.json` — `verification_commands` length differs from `verification_results` / `quality_gate.checks_run`. Validator rejects.

Each fixture is consumed by [`scripts/test-validate-quality-gate-contract.sh`](../../scripts/test-validate-quality-gate-contract.sh), which is wired into `red-release.yml` alongside the existing agent-metadata, afk-task, issue-analyzer, and task-executor contract fixture tests.

## Why this contract is documentation-only today

The PRD #196 breakdown deliberately separates phase shape from production. Landing the gate schema and validator first means the production slices (sub-agent wiring, orchestrator consumption, merge gate) can write tests against fixtures from day one, and any drift between Claude/Codex/Hermes gate implementations is caught at the contract boundary instead of at merge time. The decision to inline the gate on Codex (per [`204-codex-cli-surfaces.md`](../research/204-codex-cli-surfaces.md) §4, Option C) is the load-bearing reason the contract — not the file layout — is what makes runners interchangeable.
