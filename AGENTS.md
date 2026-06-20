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

- Work in an isolated worktree; do not change the primary checkout's branch for task work.
- Commit the worktree, push the branch early, then run `/ship` to open or reuse a PR.
- Let `/ship` monitor checks and reviews, then either merge the PR or park the issue/PR for `/hitl`.
- The agent never switches the primary checkout's branch; only the user does. The `dev.lock.primary-branch` flag in `.red/config.yaml` is the kill-switch for the primary-branch guard.
