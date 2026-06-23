<div align="center">

```
   ██████╗ ███████╗██████╗     ███████╗██╗  ██╗██╗██╗     ██╗     ███████╗
   ██╔══██╗██╔════╝██╔══██╗    ██╔════╝██║ ██╔╝██║██║     ██║     ██╔════╝
   ██████╔╝█████╗  ██║  ██║    ███████╗█████╔╝ ██║██║     ██║     ███████╗
   ██╔══██╗██╔══╝  ██║  ██║    ╚════██║██╔═██╗ ██║██║     ██║     ╚════██║
   ██║  ██║███████╗██████╔╝    ███████║██║  ██╗██║███████╗███████╗███████║
   ╚═╝  ╚═╝╚══════╝╚═════╝     ╚══════╝╚═╝  ╚═╝╚═╝╚══════╝╚══════╝╚══════╝
```

### Agent workflow, governed memory, and project brain for Claude Code and Codex.

RedSkills is reddb.io's plugin suite for running serious agentic engineering
work: turn GitHub issues into shipped PRs, preserve the operational memory that
made the work safe, and keep project knowledge searchable across sessions.

[Install](#install) · [Quick Start](#quick-start) · [Core Workflows](#core-workflows) · [Repo Layout](#repo-layout) · [Skill Index](#skill-index)

</div>

> RedSkills started as a reddb.io adaptation of
> [`mattpocock/skills`](https://github.com/mattpocock/skills). The upstream
> idea is still visible: small `SKILL.md` files that teach agents concrete
> behaviors. RedSkills adds the engineering loop, GitHub issue automation,
> governed Memory, Brain, MCP tools, release bundles, and operational guardrails
> we need for our workflows. Attribution is preserved in [NOTICE](./NOTICE).

## What This Is

RedSkills ships as three plugins that share one repository and one issue-tracker
language.

| Plugin | Owns | Use it when |
|--------|------|-------------|
| [`dev`](./plugins/dev/.claude-plugin/plugin.json) | Engineering workflow: setup, triage, PRDs, TDD, diagnosis, `/afk`, `/ship`, statusline, dashboard, process doctors, wiki, research, and codebase orientation. | You want an agent to move a repo forward through GitHub issues and reviewed PRs. |
| [`memory`](./plugins/memory/README.md) | Governed operational memory: decisions, gotchas, validation evidence, reasoning attempts, supersession, claim checks, readiness, context packs, handoffs, Workbench, MCP/HTTP read surfaces, and Skill telemetry. | You want agents to stop starting cold after `/clear` and to verify old claims before acting. |
| [`brain`](./plugins/brain/README.md) | Project-local knowledge repository: typed artifacts, Personal facts, freeform captures, search, cited synthesis, graph connections, dashboard, and channel actions. | You want to dump human/project knowledge into `.red/brain/*` and retrieve it later with citations. |

The boundary is intentional:

- **Dev moves work.** It owns the issue pipeline and mutating engineering workflows.
- **Memory improves agents.** It stores operational evidence about code work, not biographical or personal context. Memory is not the Personal-fact store.
- **Brain stores knowledge.** It owns Personal facts and durable human-facing project knowledge, not AFK attempt evidence. Personal facts belong in Brain, not Memory.

## Install

### Claude Code

Install the marketplace and the three plugins:

```text
/plugin marketplace add reddb-io/red-skills
/plugin install dev@red-skills
/plugin install memory@red-skills
/plugin install brain@red-skills
```

Common commands are native slash commands after install:

```text
/setup-red-skills
/triage
/afk --once
/ship
/dashboard
```

Memory and Brain skills are also available as plugin skills:

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

Codex installs `dev` by default. `memory` and `brain` are available from the
same marketplace metadata and can be enabled when you want those surfaces.

Codex convention is `$<skill>`:

```text
$setup-red-skills
$triage
$afk --once
$ship
$init
$recall cache TTL
$capture Save this project note...
```

Upgrade or remove:

```bash
codex plugin marketplace upgrade red-skills
codex plugin marketplace remove red-skills
```

Codex currently supports built-in footer items through `tui.status_line`, not a
command-backed statusline. RedSkills can configure a useful Codex footer, but
the live AFK block is Claude Code-only until Codex adds command-backed
statuslines. Use `$afk monitor` for live AFK visibility under Codex.

### No Marketplace

Use these paths for older agents, local hacking, or Gemini-style skill loading.

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

It configures the RedSkills operating surface for that repo:

- GitHub Issues as the issue tracker.
- Canonical triage labels such as `needs-triage`, `ready-for-agent`,
  `ready-for-human`, `running`, and `blocked:*`.
- Domain docs under `.red/CONTEXT.md` or `.red/CONTEXT-MAP.md` plus
  `.red/contexts/*/CONTEXT.md`.
- ADR directory conventions under `.red/adr/`.
- RedSkills GitHub workflows such as `red-issues-needs-triage.yml`.
- `.red/config.yaml`.
- Agent-facing `## Agent skills` and `## Development workflow` blocks in
  `AGENTS.md` and `CLAUDE.md`.
- Optional statusline wiring and branch-safety guardrails.

Re-run `/setup-red-skills` when a repo drifts. Run `/doctor` later to inspect
adoption without changing anything.

### 2. Move Work Through Issues

```text
/start                  # sharpen a plan against the domain language
/to-prd                 # publish the plan as a PRD issue
/to-issues <prd>        # cut vertical implementation slices
/triage                 # make an issue delegable
/afk                    # drain ready-for-agent work in isolated worktrees
```

Shortcuts:

- Already have a spec? Start at `/to-issues`.
- Already have a delegable issue? Start at `/triage` or `/afk --issues N`.
- Hit a bug? Use `/report-bug`, then `/triage`.
- Something is urgent? Use `/urgent`; it bypasses triage and jumps the next
  `/afk` queue selection.

### 3. Land Human-Prepared Work

`/ship` is the review-respecting finalizer for committed work in an exempt
`.red/tmp/work-ship-*/` worktree. It pushes early, opens or reuses a PR,
monitors checks/reviews with a time cap, then merges or parks the linked issue
for `/hitl`.

Use `/ship` when a human or interactive agent prepared the branch. Use `/afk`
when RedSkills should claim and execute issue work autonomously.

### 4. Turn On Memory And Brain When Useful

```text
$init                 # Memory setup: markdown-only or graph
$store Decision: ...
$recall topic
$capture Long-lived project or personal context...
$search topic
$think question
```

Use Memory for operational evidence that helps future agents act. Use Brain for
knowledge the human wants preserved and cited later.

## Core Workflows

### The Issue Pipeline

```text
idea / bug / fire
      |
      +-- /start ------> /to-prd ------> /to-issues
      |
      +-- /report-bug -----------------> needs-triage
      |
      +-- /urgent ---------------------> ready-for-agent

needs-triage -> /triage -> ready-for-agent -> /afk -> PR -> closed
                                |
                                +----------> ready-for-human -> /hitl
```

The issue thread is the durable ledger. AFK posts structured attempt envelopes,
human decisions are recorded as directive blocks, and labels represent the
current state machine. GitHub Issues are the only tracker RedSkills targets.

### AFK Execution

[`/afk`](./plugins/dev/skills/engineering/afk/SKILL.md) drains
`ready-for-agent` issues. Each worker claims an issue, creates an isolated
worktree, invokes the selected runner, validates the result, posts an envelope,
and either lands work or routes the issue to a blocked/HITL state.

Useful surfaces:

- `/afk --once` for one claim.
- `/afk --issues 123,456` for a bounded set.
- `/afk --prd 789` for a PRD slice.
- `/afk fleet N` for local fleet mode.
- `/afk monitor` for live worker state.
- [AFK Actions lane](./plugins/dev/skills/engineering/afk/actions-lane.md) for
  one-attempt GitHub Actions execution in adopter repos.

Runner identity matters. Codex callers should run with `RED_AFK_RUNNER=codex`;
Claude Code callers with `RED_AFK_RUNNER=claude`; OpenCode/hosted attempts use
the explicit runner/model env they are launched with. Do not pick a different
runner just because another binary exists on `PATH`.

### Interactive Landing

[`/ship`](./plugins/dev/skills/engineering/ship/SKILL.md) is deliberately
different from AFK landing. It respects branch protection, requested changes,
review state, and check status. If the branch cannot be merged cleanly within
the configured window, `/ship` parks the PR and issue for `/hitl`.

### Operational Views

- [`/dashboard`](./plugins/dev/skills/engineering/dashboard/SKILL.md) shows
  process state: PRDs, open issues, worker state, flow metrics, and DORA proxies.
- [`/daily-review`](./plugins/dev/skills/engineering/daily-review/SKILL.md)
  summarizes delivery from yesterday local midnight to now.
- [`/weekly-review`](./plugins/dev/skills/engineering/weekly-review/SKILL.md)
  summarizes the six-day window ending now.
- [`/retake`](./plugins/dev/skills/engineering/retake/SKILL.md) reconstructs
  one issue's local/GitHub state and prints the next command.
- [`/hitl`](./plugins/dev/skills/engineering/hitl/SKILL.md) resolves one
  `ready-for-human` issue and moves it back to `ready-for-agent` when delegable.
- [`/requeue`](./plugins/dev/skills/engineering/requeue/SKILL.md) safely puts a
  `blocked:validation`/`blocked:spec` issue back in the queue when you already
  have the retry guidance: clears the active `## Current blocker`, drops stale
  `ready-for-human`/`blocked:*` labels, adds `ready-for-agent` as one transition
  so preflight does not re-park it. Use `/hitl` when the decision still needs to
  be extracted first.

### Memory

Memory's golden path is:

```text
init -> store -> recall -> verify -> handoff
```

Modes:

| Mode | Storage | Best for |
|------|---------|----------|
| `markdown-only` | Plain files under `.red/memory/notes/`. | Low-risk rollout with explicit store/recall only. |
| `graph` | Project-local RedDB store at `.red/memory/graph.rdb`. | Governed recall, provenance, supersession, readiness, claim checks, context packs, Workbench, MCP/HTTP, and Skill telemetry. |

Start with [plugins/memory/README.md](./plugins/memory/README.md). The key rule
is that `memory recall` is the canonical agent-context path. Smart search,
vectors, Workbench, exports, and dashboards are diagnostics around the same
evidence, not replacement truth.

### Brain

Brain creates a project-local knowledge repository under `.red/brain/*`.
Artifacts are typed, searchable, connected, and available for cited synthesis.

Use it for:

- Personal facts and durable human-facing context.
- Project notes, decisions, ideas, questions, sources, references, and meeting
  residue.
- Cited answers through `brain think`.
- Visual graph exploration through `brain view`.
- Dashboard/KPI summaries over Brain artifacts.
- Optional outbound channel actions through the Brain channel bridge.

Start with [plugins/brain/README.md](./plugins/brain/README.md).

### Wiki And Research

The `dev` plugin also carries a project-local LLM Wiki:

- [`/wiki-init`](./plugins/dev/skills/knowledge/wiki-init/SKILL.md) bootstraps
  `.red/wiki/`.
- [`/wiki`](./plugins/dev/skills/knowledge/wiki/SKILL.md) ingests sources,
  answers questions, and lints contradictions/orphans/staleness.
- [`/research`](./plugins/dev/skills/knowledge/research/SKILL.md) performs
  official-source technical research and saves durable reports under
  `.red/tmp/researches/`.

Wiki is a private markdown knowledge cache. Brain is the RedDB-backed project
knowledge repository. Memory is governed operational evidence for agent work.

### Codebase Understanding

[`/zoom-out`](./plugins/dev/skills/engineering/zoom-out/SKILL.md) is the
Codebase understanding surface. It gives map-first codebase orientation:
modules, relationships, critical paths, and risks before raw detail. When
Memory Graph mode has indexed context, zoom-out can use graph neighbors as a
starting map, then verify against files.

Boundaries:

- `/zoom-out` is read-only and does not run `/memory:ingest`.
- If graph indexing is absent or stale, explicitly run `/memory:ingest <path>`
  before a later zoom-out.
- Use Memory recall (`/memory:recall`) for stored decisions/gotchas.
- Use Wiki query (`/wiki query`) for the private markdown LLM Wiki.
- The future Ask surface is still separate; zoom-out is map-first orientation,
  not the question-first answer surface.

The `dev` plugin also ships the
[code-nav MCP server](./apps/code-nav/README.md), which exposes LSP-backed
symbol tools: `workspace_symbols`, `goto_definition`, `find_references`,
`document_symbols`, and `hover`.

## Repo Layout

| Path | Purpose |
|------|---------|
| [`plugins/dev`](./plugins/dev) | Plugin definition, skills, hooks, scripts, MCP config, and docs for the engineering workflow. |
| [`plugins/memory`](./plugins/memory) | Plugin definition and skills for governed operational memory. Runtime source lives in `apps/memory`. |
| [`plugins/brain`](./plugins/brain) | Plugin definition and skills for Brain. Runtime source lives in `apps/brain`. |
| [`apps/dev`](./apps/dev) | AFK, ship, dashboard, triage, runner, and workflow runtime code. |
| [`apps/memory`](./apps/memory) | Memory CLI, graph operations, Workbench, MCP/HTTP surfaces, evals, and diagnostics. |
| [`apps/brain`](./apps/brain) | Brain CLI, store, MCP server, dashboard, channel bridge, and artifact logic. |
| [`apps/code-nav`](./apps/code-nav) | LSP-backed MCP server used by the `dev` plugin. |
| [`packages/shared`](./packages/shared) | Shared runtime helpers for plugin gates, bundle fetching, args, logging, and channels. |
| [`.red`](./.red) | RedSkills' own project configuration: context map, glossaries, ADRs, issue-tracker docs, and agent rules. |
| [`.github/workflows`](./.github/workflows) | Release, CI, upstream watch, issue automation, PR review, and reusable AFK attempt workflows. |

The installed plugin trees are definitions and launchers. Runtime bundles are
built from `apps/*` and shipped as GitHub Release assets. Session-start hooks
fetch the right bundle into the local RedSkills cache. For local development,
use the monorepo build commands below instead of expecting committed `dist/`
output inside plugin directories.

## Development

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
publish release assets, and update plugin metadata. The release process keeps
runtime bundles out of git and lets marketplace installs update cleanly.

## Configuration

Per-repo RedSkills config lives in `.red/config.yaml`. Consumer repos opt into
plugins and knobs there; the root namespace stays conservative.

Example AFK runner model config:

```yaml
afk:
  models:
    claude:
      think:
        model: claude-opus-4-8
        effort: high
    codex:
      think:
        model: gpt-5.5
        effort: high
```

Model defaults and escalation rules are documented in
[`model-tier-policy`](./plugins/dev/skills/engineering/model-tier-policy/SKILL.md).
The runtime source of truth is `CONFIG_DEFAULTS` in
[`apps/dev/src/core/config.ts`](./apps/dev/src/core/config.ts).

House rules:

- Labels are kebab-case or `prefix:value`: `needs-triage`, `ready-for-agent`,
  `ready-for-human`, `priority:urgent`, `blocked:dependency`, `prd:42`.
- RedSkills-managed workflows start with `red-`.
- Issues and PRDs live on GitHub Issues.
- Project artifacts live under `.red/`.
- Use SSH git remotes for AFK-managed repositories.
- Do task work in isolated worktrees; the primary checkout's branch is for the
  human to control.

## Skill Index

This is a map, not a replacement for the skill files. Open the linked
`SKILL.md` before using a skill in a new context.

<details>
<summary><strong>Dev: engineering workflow</strong></summary>

| Skill | Use it for |
|-------|------------|
| [`setup-red-skills`](./plugins/dev/skills/engineering/setup-red-skills/SKILL.md) | Bootstrap `.red/`, issue labels, agent rules, workflows, config, and development workflow docs. |
| [`doctor`](./plugins/dev/skills/engineering/doctor/SKILL.md) | Audit RedSkills adoption and optionally fix process drift. |
| [`start`](./plugins/dev/skills/engineering/start/SKILL.md) | Stress-test a plan against domain language and ADRs. |
| [`to-prd`](./plugins/dev/skills/engineering/to-prd/SKILL.md) | Turn the current conversation into a PRD issue. |
| [`to-issues`](./plugins/dev/skills/engineering/to-issues/SKILL.md) | Slice a plan/PRD into independently grabbable issues. |
| [`triage`](./plugins/dev/skills/engineering/triage/SKILL.md) | Move issues through the triage state machine and write agent briefs. |
| [`afk`](./plugins/dev/skills/engineering/afk/SKILL.md) | Drain `ready-for-agent` issues autonomously. |
| [`ship`](./plugins/dev/skills/engineering/ship/SKILL.md) | Finalize committed work through PR checks/reviews. |
| [`implement`](./plugins/dev/skills/engineering/implement/SKILL.md) | Interactive, human-guided PRD execution. |
| [`tdd`](./plugins/dev/skills/engineering/tdd/SKILL.md) | Red-green-refactor feature or bug work. |
| [`diagnose`](./plugins/dev/skills/engineering/diagnose/SKILL.md) | Reproduce, minimize, instrument, fix, and regression-test hard bugs. |
| [`report-bug`](./plugins/dev/skills/engineering/report-bug/SKILL.md) | File a structured `type:bug needs-triage` issue. |
| [`urgent`](./plugins/dev/skills/engineering/urgent/SKILL.md) | Create a `priority:urgent ready-for-agent` issue that jumps the queue. |
| [`hitl`](./plugins/dev/skills/engineering/hitl/SKILL.md) | Resolve one `ready-for-human` issue and make it delegable again. |
| [`requeue`](./plugins/dev/skills/engineering/requeue/SKILL.md) | Safe requeue for a `blocked:validation`/`blocked:spec` issue: clears the active blocker, drops stale labels, adds `ready-for-agent`. Use when guidance is already decided; `/hitl` is the interactive sibling. |
| [`retake`](./plugins/dev/skills/engineering/retake/SKILL.md) | Reconstruct issue/PR/local state and print the next command. |
| [`dashboard`](./plugins/dev/skills/engineering/dashboard/SKILL.md) | Inspect open PRDs/issues, AFK workers, flow metrics, and DORA proxies. |
| [`daily-review`](./plugins/dev/skills/engineering/daily-review/SKILL.md) | Produce a daily operational review. |
| [`weekly-review`](./plugins/dev/skills/engineering/weekly-review/SKILL.md) | Produce a six-day operational review. |
| [`context`](./plugins/dev/skills/engineering/context/SKILL.md) | Compose the repo context stack before non-trivial work. |
| [`zoom-out`](./plugins/dev/skills/engineering/zoom-out/SKILL.md) | Explain codebase structure map-first. |
| [`improve-codebase-architecture`](./plugins/dev/skills/engineering/improve-codebase-architecture/SKILL.md) | Find architecture deepening opportunities. |
| [`review-adrs`](./plugins/dev/skills/engineering/review-adrs/SKILL.md) | Review ADRs for contradictions, staleness, and missing supersession. |
| [`model-tier-policy`](./plugins/dev/skills/engineering/model-tier-policy/SKILL.md) | Choose model tier and validation policy across runners. |
| [`setup-statusline`](./plugins/dev/skills/engineering/setup-statusline/SKILL.md) | Install or inspect Claude/Codex statusline support. |
| [`prototype`](./plugins/dev/skills/engineering/prototype/SKILL.md) | Build a throwaway prototype for state, logic, or UI exploration. |
| [`resolving-merge-conflicts`](./plugins/dev/skills/engineering/resolving-merge-conflicts/SKILL.md) | Resolve merge conflicts by preserving both sides' intent. |
| [`curate`](./plugins/dev/skills/engineering/curate/SKILL.md) | Archive approved curatable skills from Memory recommendations. |

</details>

<details>
<summary><strong>Dev: knowledge, productivity, and utilities</strong></summary>

| Skill | Use it for |
|-------|------------|
| [`wiki-init`](./plugins/dev/skills/knowledge/wiki-init/SKILL.md) | Bootstrap `.red/wiki/`. |
| [`wiki`](./plugins/dev/skills/knowledge/wiki/SKILL.md) | Ingest/query/lint the private LLM Wiki. |
| [`research`](./plugins/dev/skills/knowledge/research/SKILL.md) | Save official-source research under `.red/tmp/researches/`. |
| [`reflect`](./plugins/dev/skills/productivity/reflect/SKILL.md) | Interview through a plan or design until decisions are explicit. |
| [`ff`](./plugins/dev/skills/productivity/ff/SKILL.md) | Rewrite a message into a chosen framing and optionally dispatch it. |
| [`handoff`](./plugins/dev/skills/productivity/handoff/SKILL.md) | Compact the current conversation into a handoff document. |
| [`write-a-skill`](./plugins/dev/skills/productivity/write-a-skill/SKILL.md) | Create a new agent skill with proper structure. |
| [`branch-lock`](./plugins/dev/skills/misc/branch-lock/SKILL.md) | Lock an agent to one branch. |
| [`git-guardrails-claude-code`](./plugins/dev/skills/misc/git-guardrails-claude-code/SKILL.md) | Add Claude Code hooks that block dangerous git commands. |
| [`migrate-to-shoehorn`](./plugins/dev/skills/misc/migrate-to-shoehorn/SKILL.md) | Replace test `as` assertions with `@total-typescript/shoehorn`. |
| [`setup-pre-commit`](./plugins/dev/skills/misc/setup-pre-commit/SKILL.md) | Configure Husky/lint-staged/typecheck/test pre-commit hooks. |

</details>

<details>
<summary><strong>Memory</strong></summary>

| Skill | Use it for |
|-------|------------|
| [`init`](./plugins/memory/skills/core/init/SKILL.md) | Initialize markdown-only or graph-backed Memory. |
| [`store`](./plugins/memory/skills/core/store/SKILL.md) | Save one scoped operational fact. |
| [`recall`](./plugins/memory/skills/core/recall/SKILL.md) | Retrieve governed context by relevance. |
| [`ingest`](./plugins/memory/skills/core/ingest/SKILL.md) | Index repo files/docs into graph mode. |
| [`extract`](./plugins/memory/skills/core/extract/SKILL.md) | Extract durable operational facts from a transcript. |
| [`context-status`](./plugins/memory/skills/core/context-status/SKILL.md) | Report context stack readiness. |
| [`skills-status`](./plugins/memory/skills/core/skills-status/SKILL.md) | Diagnose Skill telemetry and recent usage. |
| [`health`](./plugins/memory/skills/core/health/SKILL.md) | Report Memory health and next actions. |
| [`improve-skills`](./plugins/memory/skills/core/improve-skills/SKILL.md) | Create approval-gated Skill improvement proposals from evidence. |
| [`doctor`](./plugins/memory/skills/core/doctor/SKILL.md) | Inspect and prune stale graph nodes after confirmation. |
| [`export`](./plugins/memory/skills/core/export/SKILL.md) | Export graph artifacts for audit/inspection. |
| [`view`](./plugins/memory/skills/core/view/SKILL.md) | Open Memory graph views in red-ui or browser fallback. |

</details>

<details>
<summary><strong>Brain</strong></summary>

| Skill | Use it for |
|-------|------------|
| [`capture`](./plugins/brain/skills/core/capture/SKILL.md) | Save durable project or personal knowledge into Brain. |
| [`search`](./plugins/brain/skills/core/search/SKILL.md) | Search Brain artifacts. |
| [`think`](./plugins/brain/skills/core/think/SKILL.md) | Produce a cited answer from Brain evidence. |
| [`status`](./plugins/brain/skills/core/status/SKILL.md) | Inspect Brain store status. |
| [`view`](./plugins/brain/skills/core/view/SKILL.md) | Open Brain graph/connection views in red-ui. |

</details>

<details>
<summary><strong>MCP servers</strong></summary>

| Server | Use it for |
|--------|------------|
| [`code-nav`](./apps/code-nav/README.md) | IDE-grade symbol navigation through LSP-backed MCP tools. |
| [`memory-mcp`](./plugins/memory/.mcp.json) | Read Memory through MCP surfaces. |
| [`brain`](./plugins/brain/.mcp.json) | Search, think, inspect, and act through Brain MCP surfaces. |

</details>

## License

Apache-2.0. See [LICENSE](./LICENSE). See [NOTICE](./NOTICE) for upstream MIT
attribution and bundled runtime notices.
