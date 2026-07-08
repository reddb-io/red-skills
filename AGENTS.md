## Agent skills

### Wiki

Incremental LLM Wiki for accumulating knowledge about `RedSkills, agents, skills, memory instrumentation, and engineering automation patterns`. Schema template at `plugins/dev/skills/knowledge/wiki-init/schema-template.md`. Use `/wiki` for ingest, query, and lint.

### Issue tracker

GitHub Issues on `reddb-io/red-skills`. See `plugins/dev/skills/engineering/setup-red-skills/issue-tracker-github.md`.

### Triage labels

Canonical kebab-case / `prefix:value` vocab — labels match their canonical role names. See `plugins/dev/skills/engineering/setup-red-skills/triage-labels.md`.

### Domain docs

Multi-context — start at `.red/CONTEXT-MAP.md`, then read the owning glossary in
`.red/contexts/dev/CONTEXT.md`. `.red/CONTEXT.md` is a
compatibility pointer only. ADRs remain in the single root `.red/adr/` sequence
for now. See `plugins/dev/skills/engineering/setup-red-skills/domain.md`.

## Development workflow

- **Maximize autonomous `/afk` drainage — that is the mission.** The healthy steady state: every open executable issue is either `ready-for-agent` or gated for a *real, still-pending* reason. `ready-for-agent: 0` with a non-empty backlog is a **flow bug to diagnose, never a clean stop**: census the gates (`blocked:dependency` — verify each `req:*` target actually still pends, a delivered-but-open Spec strands its dependents; `needs-triage` stragglers; `ready-for-human` parks; `type:spec`) and clear the highest-leverage one. Humans enter the loop only for genuine decisions and broken flows.
- One-off concrete work goes through `/go "<demand>"` (ADR 0081): it mints a disposable `lane:go` issue, works in an isolated worktree under `.red/tmp/go-workers/`, runs the shared gate, and brings back a PR. `/go` is for **untracked ad-hoc demands only** — a tracked backlog issue belongs to `/afk`, because routing tracked work through `/go` drains the autonomous lane into human-babysat dispatches. Route the structured backlog through `/afk`; put a parked issue back in the queue with `/requeue`.
- When working by hand instead (e.g. a slice the maintainer decided to land manually), work in an isolated worktree under `.red/tmp/work-*/`; do not create sibling worktrees outside the repo.
- Create task branches with `git worktree add .red/tmp/work-<slug> -b <branch> origin/main`, not with `git checkout -b` or `git switch -c` in the primary checkout.
- Commit the worktree, push the branch early, open a PR, monitor its checks, then merge it or park the issue/PR for `/hitl`.
- The agent never switches the primary checkout's branch; only the user does. With `plugins.dev.enabled: true`, the dev command proxy blocks agent-created worktrees outside `.red/tmp/` and primary-checkout branch movement.
