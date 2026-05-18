# Engineering

Skills I use daily for code work.

- **[afk](./afk/SKILL.md)** — Autonomous loop that drains the `ready-for-agent` queue. Claims an issue, runs it in an isolated worktree via claude/codex, merges back to main, closes. Filters by PRD or explicit issue list; alternates runners on rate-limit; heartbeat + monitor + live progress.
- **[diagnose](./diagnose/SKILL.md)** — Disciplined diagnosis loop for hard bugs and performance regressions: reproduce → minimise → hypothesise → instrument → fix → regression-test.
- **[start](./start/SKILL.md)** — Grilling session that challenges your plan against the existing domain model, sharpens terminology, and updates `.red/CONTEXT.md` and ADRs inline.
- **[triage](./triage/SKILL.md)** — Triage issues through a state machine of triage roles.
- **[report-bug](./report-bug/SKILL.md)** — Interview the user about a bug they hit, then file a `type:bug needs-triage` issue on the project tracker. Seeds from conversation context when invoked with no argument.
- **[urgent](./urgent/SKILL.md)** — File a `priority:urgent` issue that bypasses `/triage` and jumps the head of the `/afk` queue, ahead of any `--prd N` / `--issues a,b,c` filter. Use when something is on fire.
- **[improve-codebase-architecture](./improve-codebase-architecture/SKILL.md)** — Find deepening opportunities in a codebase, informed by the domain language in `.red/CONTEXT.md` and the decisions in `.red/adr/`.
- **[setup-red-skills](./setup-red-skills/SKILL.md)** — Scaffold the per-repo config (issue tracker, triage label vocabulary, domain doc layout) that the other engineering skills consume.
- **[tdd](./tdd/SKILL.md)** — Test-driven development with a red-green-refactor loop. Builds features or fixes bugs one vertical slice at a time.
- **[to-issues](./to-issues/SKILL.md)** — Break any plan, spec, or PRD into independently-grabbable GitHub issues using vertical slices.
- **[to-prd](./to-prd/SKILL.md)** — Turn the current conversation context into a PRD and submit it as a GitHub issue.
- **[zoom-out](./zoom-out/SKILL.md)** — Tell the agent to zoom out and give broader context or a higher-level perspective on an unfamiliar section of code.
- **[prototype](./prototype/SKILL.md)** — Build a throwaway prototype to flesh out a design — either a runnable terminal app for state/business-logic questions, or several radically different UI variations toggleable from one route.
