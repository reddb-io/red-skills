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

The command writes proposals under:

```text
.red/memory/proposals/
```

## 2. Interpret states

- `uninitialized` — Memory is not initialized; run `/memory:init` first if Skill self-improvement is desired.
- `no-op` — Memory is initialized without graph mode; Skill telemetry cannot persist rollups here.
- `unavailable` — graph mode exists but Skill telemetry is not enabled.
- `no-candidates` — telemetry does not currently support a proposal.
- `proposal-ready` — dry-run found proposal candidates but wrote no files.
- `proposal-written` — proposal files were written for review.

## 3. Review before applying

For each proposal, inspect:

- evidence category and reason;
- target skill path;
- hypothesis;
- proposed patch targets;
- validation plan.

Only patch the skill after explicit human approval or an equivalent review gate.

## 4. Preserve the safety boundary

- ✅ Write proposals when telemetry shows repeated failure evidence.
- ✅ Treat proposal files as review artifacts, not source of truth.
- ✅ Apply the smallest skill patch that addresses the observed failure mode.
- ✅ Run repo metadata/skill validation after applying a proposal.
- ❌ Do not let Memory directly patch, archive, delete, or rewrite Skill files.
- ❌ Do not generate proposals from one-off failures without enough evidence.
- ❌ Do not store secrets or raw transcript dumps in proposals.

</what-to-do>

<supporting-info>

`memory improve skills` currently proposes fixes for curatable skills flagged as `frequently-failing` by Skill telemetry rollups. It is deliberately proposal-gated: the Memory plugin may write `.red/memory/proposals/*.md`, but applying a patch remains an explicit review step handled outside this command.

This is the first mutating stage in the self-improvement loop. The mutation is limited to proposal artifacts under `.red/memory/proposals/`; skill source files remain untouched.

</supporting-info>
