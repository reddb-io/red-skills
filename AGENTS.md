## Agent skills

### Wiki

Incremental LLM Wiki for accumulating knowledge about `RedSkills, agents, skills, memory instrumentation, and engineering automation patterns`. Schema template at `plugins/memory/skills/core/wiki-init/schema-template.md`. Use `/wiki` for ingest, query, and lint.

### Issue tracker

GitHub Issues on `reddb-io/red-skills`. See `plugins/dev/skills/engineering/red-setup/issue-tracker-github.md`.

### Triage labels

Canonical kebab-case / `prefix:value` vocab — labels match their canonical role names. See `plugins/dev/skills/engineering/red-setup/triage-labels.md`.

### Domain docs

Multi-context — start at `.red/CONTEXT-MAP.md`, then read the owning glossary in
`.red/contexts/dev/CONTEXT.md`. `.red/CONTEXT.md` is a
compatibility pointer only. ADRs remain in the single root `.red/adr/` sequence
for now. See `plugins/dev/skills/engineering/red-setup/domain.md`.

## Development workflow

- Canonical `.red/` layout follows ADR 0098: tracked knowledge/config stays in `.red/{config.yaml,adr/,contexts/,agents/,contracts/,hooks/}`, plugin stores keep their documented homes (`memory/`, `brain/`, `wiki/`), durable machine state belongs under `.red/state/`, and `.red/tmp/` is 100% disposable scratch. Every writer must use a named lane; do not create loose files directly under `.red/tmp/`.
- State lanes: `.red/state/afk/`, `.red/state/rsp/`, `.red/state/statusline/`, `.red/state/branch-lock.yaml`, and `.red/state/red-skills.rdb`. Tmp lanes: `.red/tmp/{workers,go-workers,scout-workers,claims,waits}/`, `.red/tmp/worktrees/{manual,feedback,landing,rebase,cascade,adopt,docs}/`, `.red/tmp/scratch/`, and `.red/tmp/diagnostics/`. Research reports live in gitignored `.red/researches/` until curated.
- **Maximize autonomous `/afk` drainage — that is the mission.** The healthy steady state: every open executable issue is either `ready-for-agent` or gated for a *real, still-pending* reason. `ready-for-agent: 0` with a non-empty backlog is a **flow bug to diagnose, never a clean stop**: census the gates (`blocked:dependency` — verify each `req:*` target actually still pends, a delivered-but-open Spec strands its dependents; `needs-triage` stragglers; `ready-for-human` parks; `type:spec`) and clear the highest-leverage one. Humans enter the loop only for genuine decisions and broken flows.
- One-off concrete work goes through `/go "<demand>"` (ADR 0081): it mints a disposable `lane:go` issue, works in an isolated worktree under `.red/tmp/go-workers/`, runs the shared gate, and brings back a PR. `/go` is for **untracked ad-hoc demands only** — a tracked backlog issue belongs to `/afk`, because routing tracked work through `/go` drains the autonomous lane into human-babysat dispatches. Route the structured backlog through `/afk`; put a parked issue back in the queue with `/retake`.
- **ask-red maintenance rule.** any skill add, rename, removal, or flow change must re-check `plugins/dev/skills/engineering/ask-red/SKILL.md`, update its Coverage Inventory and routes, and keep the `/red-doctor` router sync check green.
- When working by hand instead (e.g. a slice the maintainer decided to land manually), work in an isolated worktree under `.red/tmp/worktrees/manual/<slug>/`; do not create sibling worktrees outside the repo.
- Create task branches with `git worktree add .red/tmp/worktrees/manual/<slug> -b <branch> origin/main`, not with `git checkout -b` or `git switch -c` in the primary checkout.
- Check out an EXISTING branch against the REMOTE ref: `git fetch origin <branch> && git worktree add .red/tmp/worktrees/manual/<slug> -B <branch> origin/<branch>`. Never the bare `git worktree add <dir> <branch>` — that resolves the LOCAL ref, which can trail `origin/<branch>`, so the work is built on a stale tip and the push comes back `non-fast-forward`.
- Commit the worktree, push the branch early, open a PR, monitor its checks, then merge it or park the issue/PR for `/hitl`.
- The agent never switches the primary checkout's branch; only the user does. With `plugins.dev.enabled: true`, the dev command proxy blocks agent-created worktrees outside registered `.red/tmp/` lanes and primary-checkout branch movement.

## Repo-wide invariants

- **Serialization:** keep default structured files and owned wires on TOON/TOONL; follow [`guard-serialization`](plugins/dev/skills/engineering/guard-serialization/SKILL.md) on first touch.
- **Process birth:** only the host-scoped daemon births Workers; follow [`guard-process-birth`](plugins/dev/skills/engineering/guard-process-birth/SKILL.md) on first touch.

## Token-efficient terminal work

`rsp` is the repo-owned surface for token-efficient terminal work. Prefer the explicit wrappers when summarized output is enough:

- `rsp git status`, `rsp git diff`, `rsp git log`, `rsp git commit`, `rsp git push`
- `rsp gh pr list`, `rsp gh pr view`, `rsp gh issue list`, `rsp gh issue view`, `rsp gh run list`, `rsp gh run view`
- `rsp vitest`, `rsp vitest run`, `rsp cargo test`

Use `--brief` for compact summaries that keep enough inline context for normal debugging. Use `--terse` for large or repetitive output; lossy output mints an `el:<id>` handle, and `rsp show el:<id>` writes the original bytes back to stdout. Large `git diff` and `git log` output is threshold-gated and truncates by default; pass `--full` when exact inline output is required.

Use raw commands when exact stdout/stderr is the behavior under test, when a wrapper does not support the command shape, or when resolving low-level git conflicts where every byte matters. In repos whose `.red/config.yaml` sets `rsp.enabled: true`, the pre-exec hook may rewrite simple supported commands to their `rsp` wrappers; absent that opt-in, call `rsp` explicitly. The ambient host instructions that replace legacy per-host terminal guidance are tracked in #1415 and should ship from the generated `apps/rsp/generated/AMBIENT-SKILL.md` surface.
