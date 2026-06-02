# Engineering

Skills I use daily for code work.

- **[afk](./afk/SKILL.md)** — Autonomous loop that drains the `ready-for-agent` queue. Claims an issue, runs it in an isolated worktree via claude/codex, merges back to main, closes. Filters by PRD or explicit issue list; pins caller identity with `RED_AFK_RUNNER`; swaps runners only when explicitly requested; heartbeat + monitor + live progress.
- **[curate](./curate/SKILL.md)** — Interactive, archive-only Skill curator. Lists `archive` candidates from `memory curate skills --json`, requires explicit approval, archives approved Curatable skills (recoverable atomic move + SHA-256 manifest), and reverses with `/curate --restore <name>`. Tracer slice for the mutating curator.
- **[context](./context/SKILL.md)** — Compose the RedSkills context stack before non-trivial work: domain docs, ADRs, LLM Wiki, Memory graph/recall, graph-aware zoom-out, and self-improvement telemetry.
- **[diagnose](./diagnose/SKILL.md)** — Disciplined diagnosis loop for hard bugs and performance regressions: reproduce → minimise → hypothesise → instrument → fix → regression-test.
- **[start](./start/SKILL.md)** — Grilling session that challenges your plan against the existing domain model, sharpens terminology, and updates `.red/CONTEXT.md` and ADRs inline.
- **[hitl](./hitl/SKILL.md)** — Resolve one `ready-for-human` issue by extracting the pending human decision, recording the answer as Human guidance, and promoting back to `ready-for-agent` when delegable.
- **[triage](./triage/SKILL.md)** — Triage issues through a state machine of triage roles.
- **[report-bug](./report-bug/SKILL.md)** — Interview the user about a bug they hit, then file a `type:bug needs-triage` issue on the project tracker. Seeds from conversation context when invoked with no argument.
- **[urgent](./urgent/SKILL.md)** — File a `priority:urgent` issue that bypasses `/triage` and jumps the head of the `/afk` queue, ahead of any `--prd N` / `--issues a,b,c` filter. Use when something is on fire.
- **[improve-codebase-architecture](./improve-codebase-architecture/SKILL.md)** — Find deepening opportunities in a codebase, informed by the domain language in `.red/CONTEXT.md` and the decisions in `.red/adr/`.
- **[setup-red-skills](./setup-red-skills/SKILL.md)** — Scaffold the per-repo config (issue tracker, triage label vocabulary, domain doc layout) that the other engineering skills consume.
- **[doctor](./doctor/SKILL.md)** — Read-only adoption/process doctor. Reports how fully a repo adopted the stack (label vocabulary, AGENTS≡CLAUDE parity, statusline form, MCP wiring, `blocked:*` hygiene) and names each fix's home — never applies it. The recurring counterpart to `/setup-red-skills`.
- **[review-adrs](./review-adrs/SKILL.md)** — Decision-record doctor. Lints `.red/adr/` for contradictions, missing supersession links, stale references, number collisions, and controversial decisions, then **reconciles each finding through a one-question-at-a-time interview** (like `/start`) and consolidates every agreement into a single actionable PRD on the tracker via `/to-prd`. Read-only detect, interview-driven, output is a PRD.
- **[setup-statusline](./setup-statusline/SKILL.md)** — Install or inspect the RedSkills Claude Code statusline for the current repo, rendering the live AFK block via `node bin/afk.mjs statusline`.
- **[tdd](./tdd/SKILL.md)** — Test-driven development with a red-green-refactor loop. Builds features or fixes bugs one vertical slice at a time.
- **[to-issues](./to-issues/SKILL.md)** — Break any plan, spec, or PRD into independently-grabbable GitHub issues using vertical slices.
- **[to-prd](./to-prd/SKILL.md)** — Turn the current conversation context into a PRD and submit it as a GitHub issue.
- **[zoom-out](./zoom-out/SKILL.md)** — Map-first Codebase understanding for unfamiliar code; graph-aware when Memory Graph mode is ready and read-only when it is not.
- **[prototype](./prototype/SKILL.md)** — Build a throwaway prototype to flesh out a design — either a runnable terminal app for state/business-logic questions, or several radically different UI variations toggleable from one route.
