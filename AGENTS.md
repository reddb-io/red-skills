## Agent skills

### Wiki

Incremental LLM Wiki for accumulating knowledge about `RedSkills, agents, skills, memory instrumentation, and engineering automation patterns`. Schema at `.red/agents/wiki.md`. Use `/wiki` for ingest, query, and lint.

### Issue tracker

GitHub Issues on `reddb-io/red-skills`. See `.red/agents/issue-tracker.md`.

### Triage labels

Canonical kebab-case / `prefix:value` vocab — labels match their canonical role names. See `.red/agents/triage-labels.md`.

### Domain docs

Multi-context — start at `.red/CONTEXT-MAP.md`, then read the owning glossary in
`.red/contexts/{dev,memory,brain}/CONTEXT.md`. `.red/CONTEXT.md` is a
compatibility pointer only. ADRs remain in the single root `.red/adr/` sequence
for now. See `.red/agents/domain.md`.

## Development workflow

- One-off concrete work goes through `/go "<demand>"` (ADR 0081): it mints a disposable `lane:go` issue, works in an isolated worktree under `.red/tmp/go-workers/`, runs the shared gate, and brings back a PR. Route the structured backlog through `/afk`; put a parked issue back in the queue with `/requeue`.
- When working by hand instead (e.g. a slice the maintainer decided to land manually), work in an isolated worktree under `.red/tmp/work-*/`; do not create sibling worktrees outside the repo.
- Create task branches with `git worktree add .red/tmp/work-<slug> -b <branch> origin/main`, not with `git checkout -b` or `git switch -c` in the primary checkout.
- Commit the worktree, push the branch early, open a PR, monitor its checks, then merge it or park the issue/PR for `/hitl`.
- The agent never switches the primary checkout's branch; only the user does. With `plugins.dev.enabled: true`, the dev command proxy blocks agent-created worktrees outside `.red/tmp/` and primary-checkout branch movement.
