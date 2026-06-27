# RedSkills

Agent workflow, governed operational memory, and project-local knowledge for
Claude Code, Codex, OpenCode, and GitHub Actions.

RedSkills is reddb.io's plugin suite for serious agentic engineering work. It
turns GitHub issues into reviewed PRs, preserves the operational evidence that
helps agents avoid repeating mistakes, and gives projects a local knowledge
repository for human-facing context.

RedSkills started as a reddb.io adaptation of
[`mattpocock/skills`](https://github.com/mattpocock/skills). The upstream idea is
still visible: small `SKILL.md` files that teach agents concrete behaviors.
RedSkills adds the engineering loop, GitHub issue automation, governed Memory,
Brain, MCP tools, release bundles, and operational guardrails we need for our
workflows. Attribution is preserved in [NOTICE](./NOTICE).

## Table Of Contents

- [What Ships](#what-ships)
- [Plugin Boundaries](#plugin-boundaries)
  - [Dev](#dev)
  - [Memory](#memory)
  - [Brain](#brain)
- [Install](#install)
- [Quick Start](#quick-start)
- [Development Workflow](#development-workflow)
- [GitHub Actions Lane](#github-actions-lane)
- [Repo Layout](#repo-layout)
- [Configuration](#configuration)
- [Skill Index](#skill-index)
- [Development In This Repo](#development-in-this-repo)
- [License](#license)

## What Ships

RedSkills has three plugins. They share repo conventions and an issue-tracker
vocabulary, but each plugin owns a different product surface.

| Plugin                                            | Job                                                                                                                                             | Use it when                                                                                        |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [`dev`](./plugins/dev/.claude-plugin/plugin.json) | Move engineering work through GitHub Issues, isolated worktrees, AFK execution, review-gated PRs, and process dashboards.                       | You want an agent to plan, triage, execute, review, or ship code work.                             |
| [`memory`](./plugins/memory/README.md)            | Store governed operational evidence for future agents: decisions, validations, reasoning attempts, gotchas, supersession, and readiness checks. | You want agents to stop starting cold after context resets and to verify old claims before acting. |
| [`brain`](./plugins/brain/README.md)              | Store project-local human knowledge: typed artifacts, personal/project facts, sources, connections, search, cited answers, and dashboards.      | You want to capture durable knowledge the human may ask about later.                               |

The short version:

- **Dev moves work.**
- **Memory improves agent execution.**
- **Brain preserves human-facing knowledge.**

## Plugin Boundaries

### Dev

`dev` is the engineering workflow plugin. It owns the issue pipeline, the AFK
runtime, interactive landing, process visibility, setup/adoption checks, and
codebase orientation.

Core responsibilities:

- Bootstrap RedSkills into a repo with [`setup-red-skills`](./plugins/dev/skills/engineering/setup-red-skills/SKILL.md).
- Maintain GitHub Issue state through [`triage`](./plugins/dev/skills/engineering/triage/SKILL.md), [`to-prd`](./plugins/dev/skills/engineering/to-prd/SKILL.md), and [`to-issues`](./plugins/dev/skills/engineering/to-issues/SKILL.md).
- Execute delegable work with [`afk`](./plugins/dev/skills/engineering/afk/SKILL.md).
- Land interactive work with [`ship`](./plugins/dev/skills/engineering/ship/SKILL.md).
- Resolve human gates with [`hitl`](./plugins/dev/skills/engineering/hitl/SKILL.md) or safe validation/spec retries with [`requeue`](./plugins/dev/skills/engineering/requeue/SKILL.md).
- Diagnose, test-drive, prototype, review ADRs, and explain codebase structure with the engineering skills listed below.
- Expose the [code-nav MCP server](./apps/code-nav/README.md) for LSP-backed symbol navigation.

Important `dev` boundaries:

- GitHub Issues are the issue tracker. RedSkills does not target a local issue
  store or another tracker.
- `ready-for-agent` is the only issue state AFK consumes.
- `ready-for-human` means a human decision is needed before delegation is safe.
- `blocked:dependency` waits on `req:N` labels and should not page a human.
- AFK work happens in isolated worktrees. The primary checkout stays under human
  branch control.

### Memory

`memory` is governed operational memory for code agents. It stores work evidence
that can make future agents safer and faster: decisions, root causes, validation
evidence, reasoning attempts, stale-claim checks, readiness, handoffs, and skill
telemetry evidence.

Use Memory for:

- `Decision: ...`, `Problem: ...`, `Fix: ...`, and `Validation: ...` facts that
  future agents should recall.
- Claim checks before relying on old context.
- Context packs and handoffs that cite evidence instead of replaying a whole
  transcript.
- Graph-backed codebase map context and operational dashboards.
- Skill telemetry evidence and approval-gated improvement proposals.

Memory modes:

| Mode            | Storage                                               | Best for                                                                                                       |
| --------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `markdown-only` | Plain notes under `.red/memory/notes/`.               | Low-risk rollout with explicit store/recall only.                                                              |
| `graph`         | Project-local RedDB store at `.red/memory/graph.rdb`. | Governed recall, provenance, supersession, readiness, context packs, Workbench, MCP/HTTP, and Skill telemetry. |

Memory is not the Personal-fact store.
Personal facts belong in Brain, not Memory.
Broad human-facing project knowledge belongs in Brain too.

Start with [plugins/memory/README.md](./plugins/memory/README.md).

### Brain

`brain` is a project-local knowledge repository under `.red/brain/*`. It stores
typed artifacts and graph connections for later search and cited synthesis.

Use Brain for:

- Personal facts, durable preferences, identity context, relationship notes, and
  other human-facing context.
- Project notes, decisions, ideas, questions, sources, bookmarks, references, and
  meeting residue.
- `brain think` cited answers with confidence and missing-evidence signals.
- `brain dashboard` local summaries and KPI-style views.
- Optional outbound channel actions through the Brain channel bridge.

Brain is separate from Memory. Memory exists to improve agent execution; Brain
exists to preserve and connect knowledge the human wants available later.

Start with [plugins/brain/README.md](./plugins/brain/README.md).

## Install

### Claude Code

Install the marketplace and the plugins you want:

```text
/plugin marketplace add reddb-io/red-skills
/plugin install dev@red-skills
/plugin install memory@red-skills
/plugin install brain@red-skills
```

Common `dev` commands are native slash commands after install:

```text
/setup-red-skills
/triage
/afk --once
/ship
/dashboard
```

Memory and Brain skills are plugin skills:

```text
$init
$store Decision: cache TTL is 300 seconds because upstream rate limits.
$recall cache TTL
$capture Remember this project decision...
$think What do we know about the billing migration?
```

Refresh or remove:

```text
/plugin marketplace update red-skills
/plugin uninstall brain@red-skills
/plugin uninstall memory@red-skills
/plugin uninstall dev@red-skills
/plugin marketplace remove red-skills
```

### Codex CLI

Add the marketplace:

```bash
codex plugin marketplace add reddb-io/red-skills
```

Codex invokes skills with `$<skill>`. Some clients expose plugin skills with the
plugin namespace; use that form when it appears in the skills list:

```text
$dev:setup-red-skills
$dev:triage
$dev:afk --once
$dev:ship
$memory:init
$memory:recall cache TTL
$brain:capture Save this project note...
```

Upgrade or remove:

```bash
codex plugin marketplace upgrade red-skills
codex plugin marketplace remove red-skills
```

Codex currently supports built-in footer items through `tui.status_line`, not a
command-backed statusline. Use `$dev:afk monitor` when the client exposes
namespace-qualified skills, or `$afk monitor` when it exposes unqualified skill
names.

### OpenCode

OpenCode is a **third host** for RedSkills. ADR 0059 already integrates it as
the third AFK runner; ADR 0075 extends that to the developer-facing opencode
TUI by materialising the same `.red/config.yaml` block as an `opencode.json`
`provider>` entry. The adapter lives in
[`apps/opencode-host/`](./apps/opencode-host/README.md) and ships per-slice:

- **Slice 1 (this release)** — provider block. Run the generator and the
  opencode TUI on the same repo picks the same model AFK would have picked,
  with the same auth env-var (`OPENAI_API_KEY` → `MINIMAX_API_KEY` →
  `OPENROUTER_API_KEY`).

  ```bash
  # Local-dev path
  pnpm --filter @redskills/opencode-host generate

  # Bundled form (release asset)
  pnpm --filter @redskills/opencode-host bundle
  node ./dist/opencode-host.bundle.min.mjs --config .red/config.yaml --out ./opencode.json
  ```

  Auth lives in `~/.local/share/opencode/auth.json` (populated by
  `/connect` inside opencode) and the process env, **not** in the emitted
  `opencode.json` — that file is safe to commit.

- **Slice 2 (this release)** — skills + hooks. The `--with-slice-2` flag
  emits a dist tree at `./dist/opencode/<plugin>/` containing:

  - `.opencode/skills/<name>/SKILL.md` — flat-symlinked (or copied with
    `--copy`) from `plugins/<plugin>/skills/<bucket>/<name>/SKILL.md`.
    OpenCode discovers these natively; no tool wrapping required.
  - `.opencode/plugin/session-start.ts` and `.opencode/plugin/pre-tool-use.ts` —
    one TS module per Claude/Codex event class. The matcher
    (`Bash`, `Task|Agent`) is translated to an inline `input.tool` regex
    test, and `${CLAUDE_PLUGIN_ROOT}` / `${CODEX_PLUGIN_ROOT}` are
    rewritten to the opencode plugin context's `directory`.

  ```bash
  pnpm --filter @redskills/opencode-host generate -- --with-slice-2
  pnpm --filter @redskills/opencode-host generate -- --with-slice-2 --plugin dev
  ```

  Skills are validated against opencode's name rule
  (`^[a-z0-9]+(-[a-z0-9]+)*$`); a bad name is a build error, not a
  silent skip. Unsupported events (`UserPromptSubmit`, `PostToolUse`,
  `Stop`, `PreCompact`) are warn-and-continue; the source hooks the user
  actually depends on are still emitted.

- **Slices 3-5 (next)** — MCP passthrough, agents → subagents, and a
  remote-install form. The Slice 1 + 2 contract is stable; later slices
  add files under `dist/opencode/<plugin>/` without changing
  `provider-block.ts`, `skills-to-opencode.ts`, or `hooks-to-events.ts`.

### No Marketplace

Use these paths for older agents, local hacking, or Gemini-style skill loading:

```bash
npx skills@latest add reddb-io/red-skills
```

For a local checkout with symlinked skills:

```bash
git clone git@github.com:reddb-io/red-skills.git ~/code/red-skills
cd ~/code/red-skills
./scripts/link-skills.sh
```

Marketplace installs auto-update. `npx skills` and manual symlinks do not.

### Verify Runners

Before a release, or after upgrading Claude Code/Codex, run:

```bash
./scripts/doctor-runners.sh
```

It checks plugin metadata, shell syntax, runner flags used by `/afk`, Codex
marketplace registration in a temporary home, and manual skill-link installs.

## Quick Start

### 1. Bootstrap A Repo

Run this inside a target repository:

```text
/setup-red-skills
```

It creates and wires the RedSkills operating surface:

- `.red/config.yaml` with explicit `plugins.<name>.enabled: true` activation
  flags.
- GitHub issue labels such as `needs-triage`, `ready-for-agent`,
  `ready-for-human`, `running`, `blocked:*`, `blocked:dependency`, and `req:N`.
- Domain docs under `.red/CONTEXT-MAP.md`, `.red/contexts/*/CONTEXT.md`, and
  ADRs under `.red/adr/`.
- `AGENTS.md` / `CLAUDE.md` blocks for agent skills and the development
  workflow.
- RedSkills workflows such as `red-issues-needs-triage.yml`.
- Optional statusline wiring and primary-checkout branch guardrails.

Re-run `/setup-red-skills` when adoption drifts. Run `/doctor` to inspect drift
without changing anything, or `/doctor --fix` for the approved repair path.

### 2. Move Work Through Issues

```text
/start                  # sharpen a plan against domain language and ADRs
/to-prd                 # publish the plan as a PRD issue
/to-issues <prd>        # cut vertical implementation slices
/triage                 # make an issue delegable
/afk                    # drain ready-for-agent work in isolated worktrees
```

Shortcuts:

- Already have a delegable issue? Use `/afk --issues N`.
- Already have a spec? Use `/to-issues` or `/triage`.
- Hit a bug? Use `/report-bug`, then `/triage`.
- Something is urgent? Use `/urgent`; it creates a `priority:urgent`
  `ready-for-agent` issue that jumps the queue.

### 3. Use Memory And Brain Deliberately

```text
$init                 # Memory setup: markdown-only or graph
$store Decision: ...
$recall topic
$capture Long-lived project or personal context...
$search topic
$think question
```

Use Memory for operational evidence that helps future agents act. Use Brain for
knowledge the human wants preserved, searched, and cited later.

## Development Workflow

RedSkills teaches and enforces one interactive development loop:

1. Keep the **primary checkout** on `main`; only the human switches it.
2. Do task work in an isolated worktree, normally under `.red/tmp/work-ship-*`
   when you intend to use `/ship`.
3. Commit the worktree.
4. Push the branch early.
5. Run `/ship` from the committed worktree to open or reuse a PR.
6. Let `/ship` monitor checks and reviews with a time cap.
7. `/ship` merges normally when checks are green, branch protection is satisfied,
   and no reviewer requested changes.
8. If review, CI, branch protection, or the time cap blocks the merge, `/ship`
   parks the linked issue and PR in `ready-for-human` for `/hitl`.

This is the human-in-the-loop sibling of AFK landing:

| Flow    | Use it when                                                               | Landing behavior                                                                                                             |
| ------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `/afk`  | Work is already `ready-for-agent` and should be executed autonomously.    | AFK claims the issue, creates its own worktree, validates, posts an envelope, and lands through its autonomous landing path. |
| `/ship` | A human or interactive agent has already prepared and committed a branch. | `/ship` respects branch protection, reviews, checks, advisory bots, and the time cap.                                        |

The issue lifecycle is:

```text
needs-triage -> /triage -> ready-for-agent -> /afk -> PR/merge -> closed
                                |
                                +---- blocked/spec/validation/etc.
                                      -> ready-for-human -> /hitl or /requeue
```

Important details:

- `running` is timeline-only. There is no periodic issue-thread heartbeat; live
  worker state is local (`agent.log.jsonl`, `afk.state.json`, process liveness)
  and visible through `/afk monitor`.
- `blocked:dependency` issues wait on `req:N` labels and auto-unblock when the
  last dependency closes.
- `blocked:validation` and `blocked:spec` can use `/requeue` only when the retry
  guidance is already decided; use `/hitl` when the decision still needs to be
  extracted from the thread.
- The primary-checkout branch guard is controlled by
  `plugins.dev.lock.primary-branch` in `.red/config.yaml`.

## GitHub Actions Lane

The AFK Actions lane runs one AFK attempt per issue from GitHub Actions. It is
for adopter repos that want cloud execution without a local fleet.

Architecture:

| Layer                | Artifact                                                                   | Job                                                                         |
| -------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Trigger + policy     | [`reusable-afk-attempt.yml`](./.github/workflows/reusable-afk-attempt.yml) | `workflow_call`, manual dispatch, and trust gate.                           |
| Execution            | [`.github/actions/afk-attempt`](./.github/actions/afk-attempt/action.yml)  | Sets up Node, runner CLI, auth env, and invokes the AFK launcher.           |
| Runtime distribution | `afk.mjs` + GitHub Release assets                                          | Fetches the versioned `dev` bundle matching the checked-out red-skills ref. |

Adoption paths:

- **Turnkey caller:** install or copy an `rs-afk-attempt.yml` caller that wires
  issue/manual triggers to
  `reddb-io/red-skills/.github/workflows/reusable-afk-attempt.yml@v1`.
- **Composable action:** use
  `reddb-io/red-skills/.github/actions/afk-attempt@v1` from your own workflow.

Pin `@v1` to track the latest compatible v1 release. Pin a SHA when the caller
needs a fully immutable action/runtime pair.

Workflow naming convention:

| Prefix       | Meaning                                                                              |
| ------------ | ------------------------------------------------------------------------------------ |
| `reusable-*` | Reusable `workflow_call` workflow referenced by `uses:`; never copied into adopters. |
| `rs-*`       | A caller that instantiates a `reusable-*` workflow with concrete triggers/inputs.    |
| `red-*`      | Standalone RedSkills workflow; internal CI or verbatim copy-installable.             |

Full guide: [AFK Actions lane](./plugins/dev/skills/engineering/afk/actions-lane.md).

## Repo Layout

| Path                                       | Purpose                                                                                                   |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| [`plugins/dev`](./plugins/dev)             | Plugin definition, skills, hooks, scripts, MCP config, and docs for engineering workflow.                 |
| [`plugins/memory`](./plugins/memory)       | Plugin definition and skills for governed operational memory. Runtime source lives in `apps/memory`.      |
| [`plugins/brain`](./plugins/brain)         | Plugin definition and skills for Brain. Runtime source lives in `apps/brain`.                             |
| [`apps/dev`](./apps/dev)                   | AFK, ship, dashboard, triage, runner, release/channel, and workflow runtime code.                         |
| [`apps/memory`](./apps/memory)             | Memory CLI, graph operations, Workbench, MCP/HTTP surfaces, evals, and diagnostics.                       |
| [`apps/brain`](./apps/brain)               | Brain CLI, store, MCP server, dashboard, channel bridge, and artifact logic.                              |
| [`apps/code-nav`](./apps/code-nav)         | LSP-backed MCP server used by the `dev` plugin.                                                           |
| [`apps/opencode-host`](./apps/opencode-host) | Adapter that emits `opencode.json` from `.red/config.yaml` (Slice 1: provider block; Slices 2-5: skills/hooks/MCP/agents). |
| [`packages/shared`](./packages/shared)     | Shared runtime helpers for plugin gates, bundle fetching, args, logging, and channels.                    |
| [`.red`](./.red)                           | RedSkills' own project configuration: context map, glossaries, ADRs, issue-tracker docs, and agent rules. |
| [`.github/workflows`](./.github/workflows) | Release, CI, upstream watch, issue automation, PR review, and reusable AFK attempt workflows.             |

Installed plugin trees are definitions and launchers. Runtime bundles are built
from `apps/*` and shipped as GitHub Release assets. Session-start hooks fetch the
right bundle into the local RedSkills cache.

## Configuration

Per-repo RedSkills config lives in `.red/config.yaml`. The canonical written
form is namespaced under `plugins.<name>.*`.

Minimal `dev` activation:

```yaml
plugins:
  dev:
    enabled: true
    lock:
      primary-branch: true
```

Example runner/model config:

```yaml
plugins:
  dev:
    enabled: true
    afk:
      models:
        opencode:
          think:
            model: minimax/MiniMax-M3
```

Model defaults and escalation rules are documented in
[`model-tier-policy`](./plugins/dev/skills/engineering/model-tier-policy/SKILL.md).
The runtime source of truth is `CONFIG_DEFAULTS` in
[`apps/dev/src/core/config.ts`](./apps/dev/src/core/config.ts).

House rules:

- Labels are kebab-case or `prefix:value`: `needs-triage`, `ready-for-agent`,
  `ready-for-human`, `priority:urgent`, `blocked:dependency`, `prd:42`.
- RedSkills-managed workflows use role prefixes: `red-*`, `reusable-*`, or
  `rs-*`.
- Issues and PRDs live on GitHub Issues.
- Project artifacts live under `.red/`.
- Use SSH git remotes for AFK-managed repositories.
- Do task work in isolated worktrees; the primary checkout's branch is for the
  human to control.

## Skill Index

This is a map, not a replacement for the skill files. Open the linked `SKILL.md`
before using a skill in a new context.

### Dev: Setup And Issue Flow

| Skill                                                                            | Use it for                                                                                |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [`setup-red-skills`](./plugins/dev/skills/engineering/setup-red-skills/SKILL.md) | Bootstrap `.red/`, labels, agent rules, workflows, config, and development workflow docs. |
| [`doctor`](./plugins/dev/skills/engineering/doctor/SKILL.md)                     | Audit RedSkills adoption and optionally fix process drift.                                |
| [`start`](./plugins/dev/skills/engineering/start/SKILL.md)                       | Stress-test a plan against domain language and ADRs.                                      |
| [`to-prd`](./plugins/dev/skills/engineering/to-prd/SKILL.md)                     | Turn the current conversation into a PRD issue.                                           |
| [`to-issues`](./plugins/dev/skills/engineering/to-issues/SKILL.md)               | Slice a plan/PRD into independently grabbable issues.                                     |
| [`triage`](./plugins/dev/skills/engineering/triage/SKILL.md)                     | Move issues through the triage state machine and write agent briefs.                      |
| [`report-bug`](./plugins/dev/skills/engineering/report-bug/SKILL.md)             | File a structured `type:bug needs-triage` issue.                                          |
| [`urgent`](./plugins/dev/skills/engineering/urgent/SKILL.md)                     | Create a `priority:urgent ready-for-agent` issue that jumps the queue.                    |

### Dev: Execution, Landing, And Recovery

| Skill                                                                                              | Use it for                                                                                         |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [`afk`](./plugins/dev/skills/engineering/afk/SKILL.md)                                             | Drain `ready-for-agent` issues autonomously.                                                       |
| [`ship`](./plugins/dev/skills/engineering/ship/SKILL.md)                                           | Finalize committed work through PR checks/reviews.                                                 |
| [`implement`](./plugins/dev/skills/engineering/implement/SKILL.md)                                 | Interactive, human-guided PRD execution.                                                           |
| [`tdd`](./plugins/dev/skills/engineering/tdd/SKILL.md)                                             | Red-green-refactor feature or bug work.                                                            |
| [`diagnose`](./plugins/dev/skills/engineering/diagnose/SKILL.md)                                   | Reproduce, minimize, instrument, fix, and regression-test hard bugs.                               |
| [`hitl`](./plugins/dev/skills/engineering/hitl/SKILL.md)                                           | Resolve one `ready-for-human` issue and make it delegable again.                                   |
| [`requeue`](./plugins/dev/skills/engineering/requeue/SKILL.md)                                     | Safely requeue a `blocked:validation`/`blocked:spec` issue when retry guidance is already decided. |
| [`retake`](./plugins/dev/skills/engineering/retake/SKILL.md)                                       | Reconstruct issue/PR/local state and print the next command.                                       |
| [`resolving-merge-conflicts`](./plugins/dev/skills/engineering/resolving-merge-conflicts/SKILL.md) | Resolve merge conflicts while preserving both sides' intent.                                       |

### Dev: Operations And Understanding

| Skill                                                                                                      | Use it for                                                             |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [`dashboard`](./plugins/dev/skills/engineering/dashboard/SKILL.md)                                         | Inspect open PRDs/issues, AFK workers, flow metrics, and DORA proxies. |
| [`daily-review`](./plugins/dev/skills/engineering/daily-review/SKILL.md)                                   | Produce a daily operational review.                                    |
| [`weekly-review`](./plugins/dev/skills/engineering/weekly-review/SKILL.md)                                 | Produce a six-day operational review.                                  |
| [`context`](./plugins/dev/skills/engineering/context/SKILL.md)                                             | Compose the repo context stack before non-trivial work.                |
| [`zoom-out`](./plugins/dev/skills/engineering/zoom-out/SKILL.md)                                           | Explain codebase structure map-first.                                  |
| [`improve-codebase-architecture`](./plugins/dev/skills/engineering/improve-codebase-architecture/SKILL.md) | Find architecture deepening opportunities.                             |
| [`review-adrs`](./plugins/dev/skills/engineering/review-adrs/SKILL.md)                                     | Review ADRs for contradictions, staleness, and missing supersession.   |
| [`model-tier-policy`](./plugins/dev/skills/engineering/model-tier-policy/SKILL.md)                         | Choose model tier and validation policy across runners.                |
| [`setup-statusline`](./plugins/dev/skills/engineering/setup-statusline/SKILL.md)                           | Install or inspect Claude/Codex statusline support.                    |
| [`prototype`](./plugins/dev/skills/engineering/prototype/SKILL.md)                                         | Build a throwaway prototype for state, logic, or UI exploration.       |
| [`curate`](./plugins/dev/skills/engineering/curate/SKILL.md)                                               | Archive approved curatable skills from Memory recommendations.         |

### Dev: Knowledge, Productivity, And Utilities

| Skill                                                                                         | Use it for                                                          |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [`wiki-init`](./plugins/dev/skills/knowledge/wiki-init/SKILL.md)                              | Bootstrap `.red/wiki/`.                                             |
| [`wiki`](./plugins/dev/skills/knowledge/wiki/SKILL.md)                                        | Ingest/query/lint the private LLM Wiki.                             |
| [`research`](./plugins/dev/skills/knowledge/research/SKILL.md)                                | Save official-source research under `.red/tmp/researches/`.         |
| [`reflect`](./plugins/dev/skills/productivity/reflect/SKILL.md)                               | Interview through a plan or design until decisions are explicit.    |
| [`ff`](./plugins/dev/skills/productivity/ff/SKILL.md)                                         | Rewrite a message into a chosen framing and optionally dispatch it. |
| [`handoff`](./plugins/dev/skills/productivity/handoff/SKILL.md)                               | Compact the current conversation into a handoff document.           |
| [`write-a-skill`](./plugins/dev/skills/productivity/write-a-skill/SKILL.md)                   | Create a new agent skill with proper structure.                     |
| [`branch-lock`](./plugins/dev/skills/misc/branch-lock/SKILL.md)                               | Lock an agent to one branch.                                        |
| [`git-guardrails-claude-code`](./plugins/dev/skills/misc/git-guardrails-claude-code/SKILL.md) | Add Claude Code hooks that block dangerous git commands.            |
| [`migrate-to-shoehorn`](./plugins/dev/skills/misc/migrate-to-shoehorn/SKILL.md)               | Replace test `as` assertions with `@total-typescript/shoehorn`.     |
| [`setup-pre-commit`](./plugins/dev/skills/misc/setup-pre-commit/SKILL.md)                     | Configure Husky/lint-staged/typecheck/test pre-commit hooks.        |

### Memory

| Skill                                                                    | Use it for                                                       |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| [`init`](./plugins/memory/skills/core/init/SKILL.md)                     | Initialize markdown-only or graph-backed Memory.                 |
| [`store`](./plugins/memory/skills/core/store/SKILL.md)                   | Save one scoped operational fact.                                |
| [`recall`](./plugins/memory/skills/core/recall/SKILL.md)                 | Retrieve governed context by relevance.                          |
| [`ingest`](./plugins/memory/skills/core/ingest/SKILL.md)                 | Index repo files/docs into graph mode.                           |
| [`extract`](./plugins/memory/skills/core/extract/SKILL.md)               | Extract durable operational facts from a transcript.             |
| [`context-status`](./plugins/memory/skills/core/context-status/SKILL.md) | Report context stack readiness.                                  |
| [`skills-status`](./plugins/memory/skills/core/skills-status/SKILL.md)   | Diagnose Skill telemetry and recent usage.                       |
| [`health`](./plugins/memory/skills/core/health/SKILL.md)                 | Report Memory health and next actions.                           |
| [`improve-skills`](./plugins/memory/skills/core/improve-skills/SKILL.md) | Create approval-gated Skill improvement proposals from evidence. |
| [`doctor`](./plugins/memory/skills/core/doctor/SKILL.md)                 | Inspect and prune stale graph nodes after confirmation.          |
| [`export`](./plugins/memory/skills/core/export/SKILL.md)                 | Export graph artifacts for audit/inspection.                     |
| [`view`](./plugins/memory/skills/core/view/SKILL.md)                     | Open Memory graph views in red-ui or browser fallback.           |

### Brain

| Skill                                                     | Use it for                                             |
| --------------------------------------------------------- | ------------------------------------------------------ |
| [`capture`](./plugins/brain/skills/core/capture/SKILL.md) | Save durable project or personal knowledge into Brain. |
| [`search`](./plugins/brain/skills/core/search/SKILL.md)   | Search Brain artifacts.                                |
| [`think`](./plugins/brain/skills/core/think/SKILL.md)     | Produce a cited answer from Brain evidence.            |
| [`status`](./plugins/brain/skills/core/status/SKILL.md)   | Inspect Brain store status.                            |
| [`view`](./plugins/brain/skills/core/view/SKILL.md)       | Open Brain graph/connection views in red-ui.           |

### MCP Servers

| Server                                     | Use it for                                                  |
| ------------------------------------------ | ----------------------------------------------------------- |
| [`code-nav`](./apps/code-nav/README.md)    | IDE-grade symbol navigation through LSP-backed MCP tools.   |
| [`memory-mcp`](./plugins/memory/.mcp.json) | Read Memory through MCP surfaces.                           |
| [`brain`](./plugins/brain/.mcp.json)       | Search, think, inspect, and act through Brain MCP surfaces. |

## Development In This Repo

Install dependencies:

```bash
pnpm install
```

Common checks:

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm bundle
./scripts/doctor-runners.sh
```

The workspace is managed by [`turbo`](./turbo.json) and
[`pnpm-workspace.yaml`](./pnpm-workspace.yaml). Root scripts intentionally cover
the runtime apps and shared packages while excluding unrelated heavy packages
where needed.

Release is automated by [red-release.yml](./.github/workflows/red-release.yml):
pushes to `main` with release-worthy commits bump versions, build bundles,
publish release assets, update plugin metadata, and move the matching major tag
such as `v1` to the same release commit so reusable workflows pinned to `@v1`
keep advancing.

## License

Apache-2.0. See [LICENSE](./LICENSE). See [NOTICE](./NOTICE) for upstream MIT
attribution and bundled runtime notices.
