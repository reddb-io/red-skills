# 0148 — `@reddb-io/worker`: red-castle and the ACP Worker merge into one body

- **Status**: accepted
- **Date**: 2026-08-18
- **Related**: ADR 0033/0061/0101 (sandcastle → red-castle lineage), ADR 0123 (pruned castle), ADR 0144 §4 (Workers are cattle), ADR 0145 §5 (Worker as ACP Agent and Client), ADR 0147 (one binary)
- **Sources**: the `/start` grilling session of 2026-08-18

## Context

Two Worker bodies exist. The dev bundle Worker (`red-skills-dev run --once`,
argv composed project-side in `launch-template.ts`) imports the red-castle engine
in-process; the native ACP Worker (`redskilled acp-worker`) re-execs the daemon
and speaks ACP up and down. `packages/red-castle` holds ~29k lines of source and
~39k of tests with **zero** ACP; the seventeen `acp-*` modules live in
`apps/redskilled/src`, seven of them running inside the Worker process. Two
bodies is twice the cost ADR 0144 was written to remove.

## Decision

**One Worker body, in its own package `packages/worker` (`@reddb-io/worker`),
embedded in the `redskilled` binary and started as `redskilled acp-worker`.**
It merges the proven red-castle substrate — agent providers (claude-code, codex,
opencode, pi, redcode), sandbox providers (no-sandbox, docker, podman), worktree
materialisation, `InitService`, gate runner, spin evaluator, lifecycle hooks,
terminal events, contracts — with the Worker-side ACP modules
(`acp-native-worker`, `acp-child-agent`, `acp-child-spin`, `acp-worker-lifecycle`,
`acp-worker-command`, `acp-workflow-turn`, `acp-worker-budget-grace`).

**The cut is body versus control.** Whatever runs *inside* the Worker process —
birthing the child agent, the turn loop, re-seed, local gate stages, sandbox,
worktree, logging — belongs to the package. Whatever decides *whether, when and
where* a Worker exists — admission, budget, placement, session journal, GitHub
gateway, dispatch intent, retake evidence, agent catalog — stays in the daemon.
The shared wire — ACP v1/v2 compat, wire major, socket transport,
`_redskills/*` method schemas — moves to `packages/protocol-acp`
(`@reddb-io/protocol-acp`), depended on by daemon, Worker and Plugin MCPs.

**The inner agent only edits and commits.** The Worker answers filesystem,
terminal and permission requests, denies `git push` and `gh` in its terminal
policy, and after the turn requests publish, PR, land and memory from the daemon
over ACP. This is ADR 0144 §3 made mechanical: no credential ever reaches the
process that runs the model.

red-castle's `cli.ts` dies; its `mcp/*` schemas move to `rs_dev`; its tracker
(queue, claim) moves to the daemon. The package keeps its sandcastle lineage in
`NOTICE`, and its mission statement is the Worker alone — a separate package so
that later hosts (a subagent surface, an editor) can embed the same body.

## Considered options

- Dissolve red-castle into `apps/redskilled/src/worker/`. Rejected: the boundary
  is what keeps the Worker testable and embeddable outside the daemon.
- A separate `worker` binary. Rejected by ADR 0147: one binary; the package is a
  library the daemon loads on `acp-worker`.
- Keep the dev bundle Worker and rename it. Rejected: it is the body that
  carries the CLI, the client-side argv composition and the in-process engine
  the daemon cannot see.
