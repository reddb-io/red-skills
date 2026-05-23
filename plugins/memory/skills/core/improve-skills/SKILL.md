---
name: improve-skills
description: Generate approval-gated Skill improvement proposals from Memory Skill telemetry. Use when repeated failures suggest a skill should be patched, but direct self-modification would be unsafe.
---

# memory improve-skills

Generate concrete Skill improvement proposals from Skill telemetry evidence.

<what-to-do>

## 1. Run the proposal surface

Prefer JSON when another agent or command will inspect the result:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" improve skills --json
```

To write proposal files:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" improve skills --write-proposal --json
```

To apply a reviewed proposal that contains a structured patch block:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" improve apply .red/memory/proposals/<proposal>.md --yes --json
```

The command writes proposals under:

```text
.red/memory/proposals/
```

## 2. Interpret states

- `uninitialized` — Memory is not initialized; run `/memory:init` first if Skill self-improvement is desired.
- `no-op` — Memory is initialized without graph mode; Skill telemetry cannot persist rollups here.
- `unavailable` — graph mode exists but Skill telemetry is not enabled.
- `no-candidates` — telemetry does not currently support a proposal.
- `proposal-ready` — dry-run found proposal candidates but wrote no files. JSON summaries include `recentFailures`, `dominantErrorStage`, `dominantErrorClass`, `patchDrafted`, `score`, `priority`, and `scoreReasons` for machine-readable routing.
- `proposal-written` — proposal files were written for review, including recent failure evidence and a draft structured patch block when the skill file has a safe unique insertion anchor.
- `applied` — an explicitly approved structured patch was applied.

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
- ✅ Apply the smallest skill patch that addresses the observed failure mode.
- ✅ Run repo metadata/skill validation after applying a proposal.
- ✅ Include recent failed result evidence in proposals so reviewers see the stage/class/code that triggered the recommendation.
- ✅ Rank proposal candidates by deterministic priority score so agents fix the highest-impact failure loops first.
- ✅ Generate a draft `json memory-skill-patch` block only when the target skill is readable and has a safe unique anchor.
- ✅ Require `--yes` and an exact `oldString` match before applying a proposal.
- ❌ Do not let Memory patch anything unless the proposal has a structured apply block.
- ❌ Do not let Memory archive, delete, or rewrite Skill files outside the reviewed patch target.
- ❌ Do not generate proposals from one-off failures without enough evidence.
- ❌ Do not store secrets or raw transcript dumps in proposals.

</what-to-do>

<supporting-info>

`memory improve skills` currently proposes fixes for curatable skills flagged as `frequently-failing` by Skill telemetry rollups. It is deliberately proposal-gated: the Memory plugin may write `.red/memory/proposals/*.md`, but applying a patch remains an explicit review step handled outside this command.

This is the first mutating stage in the self-improvement loop. Proposal generation mutates only `.red/memory/proposals/`; proposal application can patch a target skill only when a reviewed structured block plus `--yes` are both present.

</supporting-info>
