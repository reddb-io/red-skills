---
name: improve-skills
working-mode: interactive
description: Generate approval-gated Skill improvement proposals from Memory Skill telemetry. Use when repeated failures suggest a skill should be patched, but direct self-modification would be unsafe.
disable-model-invocation: true
---

# memory improve-skills

Generate concrete Skill improvement proposals from Skill telemetry evidence.

<what-to-do>

**Generate approval-gated Skill improvement proposals from telemetry evidence, review each one before applying, and never patch a skill without explicit human approval.**

## 1. Run the proposal surface

Prefer JSON when another agent or command will inspect the result:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.mjs" improve skills --json
```

To write proposal files:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.mjs" improve skills --write-proposal --json
```

To list and inspect pending proposal files before applying or archiving:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.mjs" improve proposals list --json
node "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.mjs" improve proposals show .red/memory/proposals/<proposal>.md --json
```

To apply a reviewed proposal that contains a structured patch block:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.mjs" improve apply .red/memory/proposals/<proposal>.md --yes --json
```

To remove a reviewed proposal from the pending queue without deleting history:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.mjs" improve proposals archive .red/memory/proposals/<proposal>.md --reason rejected --yes --json
```

The command writes proposals under:

```text
.red/memory/proposals/
```

## 2. Interpret states

See [init-chain state taxonomy](../../references/PRECONDITIONS.md#init-chain-state-taxonomy) — for `uninitialized`, run `/memory:init`; for `no-op`, re-run with `--mode graph`; for `unavailable`, add `--skill-telemetry`.
- `no-candidates` — telemetry does not currently support a proposal.
- `proposal-ready` — dry-run found proposal candidates but wrote no files. JSON summaries include `recentFailures`, `dominantErrorStage`, `dominantErrorClass`, `patchDrafted`, `score`, `priority`, and `scoreReasons` for machine-readable routing.
- `proposal-written` — proposal files were written or refreshed for review, including recent failure evidence, a deterministic `Fingerprint`, and a draft structured patch block when the skill file has a safe unique insertion anchor.
- `applied` — an explicitly approved structured patch was applied.
- `pending` — proposal lifecycle listing found pending proposal files.
- `shown` — a specific proposal file was returned for review.
- `archived` — a proposal was moved under `.red/memory/proposals/archive/<reason>/`.

## 3. Review before applying

For each proposal, inspect:

- evidence category and reason;
- target skill path;
- hypothesis;
- proposed patch targets;
- validation plan.

Only patch the skill after explicit human approval or an equivalent review gate.

`memory improve apply` refuses to run unless all of these are true:

- the command includes `--yes`;
- the proposal contains a fenced ````json memory-skill-patch` block;
- the proposal file and patch target remain inside `--root`;
- `oldString` appears exactly once in the target file.

Patch block format:

````markdown
```json memory-skill-patch
{
  "path": "plugins/dev/skills/example/SKILL.md",
  "oldString": "text to replace",
  "newString": "replacement text"
}
```
````

## 4. Preserve the safety boundary

- ✅ Write proposals when telemetry shows repeated failure evidence.
- ✅ Treat proposal files as review artifacts, not source of truth.
- ✅ Use `memory improve proposals list/show/archive` to keep the pending queue clean and auditable.
- ✅ Expect repeated runs to reuse a pending proposal with the same fingerprint instead of creating duplicates.
- ✅ Review the generated `oldString`: it should target `Setup`/`Prerequisites` for setup failures, `Execution`/`Commands` for execute failures, `Verification`/`Validation` for verify failures, and `Troubleshooting`/`Common Pitfalls` for timeout/lock/rate-limit style failures when those sections exist.
- ✅ Apply the smallest skill patch that addresses the observed failure mode.
- ✅ Run repo metadata/skill validation after applying a proposal.
- ✅ Include recent failed result evidence in proposals so reviewers see the stage/class/code that triggered the recommendation.
- ✅ Rank proposal candidates by deterministic priority score so agents fix the highest-impact failure loops first.
- ✅ Generate a draft `json memory-skill-patch` block only when the target skill is readable and has a safe unique anchor.
- ✅ Require `--yes` and an exact `oldString` match before applying a proposal.
- ❌ Do not let Memory patch anything unless the proposal has a structured apply block.
- ❌ Do not let Memory archive proposals without `--yes` and an explicit `--reason applied|rejected|stale`.
- ❌ Do not let Memory archive, delete, or rewrite Skill files outside the reviewed patch target.
- ❌ Do not generate proposals from one-off failures without enough evidence.
- ❌ Do not store secrets or raw transcript dumps in proposals.

</what-to-do>

<supporting-info>

`memory improve skills` currently proposes fixes for curatable skills flagged as `frequently-failing` by partitioned Skill telemetry rollups. Each Evidence card gets a deterministic fingerprint from its telemetry source, refinement route, dominant error pattern, and telemetry window; unresolved cards in `captured`, `routed`, or `proposed` status with the same fingerprint are refreshed in place, while reviewed or terminal cards (`approved`, `rejected`, `promoted`, `archived`) are preserved and a later run creates a new card. Draft patch blocks choose a semantic section anchor from the dominant failure stage/class before falling back to a tail anchor. It is deliberately proposal-gated: the Memory plugin may write `.red/memory/proposals/*.md`, but applying a patch remains an explicit review step handled outside this command.

This is the first mutating stage in the self-improvement loop. Proposal generation mutates only `.red/memory/proposals/`; proposal application can patch a target skill only when a reviewed structured block plus `--yes` are both present.

</supporting-info>
