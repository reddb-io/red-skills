<div align="center">

<img src="docs/hero.svg" alt="RedSkills - agent workflow, governed Memory, and Brain knowledge for serious engineering agents" width="100%" />

<p>
  <a href="https://www.npmjs.com/package/@reddb-io/red-skills"><img src="https://img.shields.io/npm/v/%40reddb-io%2Fred-skills?style=for-the-badge&label=npm&color=ff2056&labelColor=0d1117" alt="npm version"></a>
  <a href="https://github.com/reddb-io/red-skills/actions/workflows/red-workspace-ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/reddb-io/red-skills/red-workspace-ci.yml?branch=main&style=for-the-badge&label=CI&labelColor=0d1117" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue?style=for-the-badge&labelColor=0d1117" alt="License"></a>
  <a href=".claude-plugin/marketplace.json"><img src="https://img.shields.io/badge/marketplace-dev%20%7C%20memory%20%7C%20brain-ff2056?style=for-the-badge&label=plugins&labelColor=0d1117" alt="Plugins"></a>
</p>

<strong>The operating system for agentic engineering work.</strong><br>
RedSkills turns GitHub issues into reviewed PRs, remembers the operational
evidence that prevents repeated mistakes, and gives every repo a local knowledge
surface for Claude Code, Codex, OpenCode, Pi, and GitHub Actions.

</div>

---

RedSkills is reddb.io's plugin suite for serious code-agent workflows. It
started as a reddb.io adaptation of
[`mattpocock/skills`](https://github.com/mattpocock/skills): small `SKILL.md`
files that teach agents concrete behaviors. RedSkills keeps that core and adds
the pieces teams need when agents are doing real engineering work: issue
automation, isolated worktrees, AFK execution, governed Memory, Brain, MCP
servers, release bundles, status signals, and guardrails.

Attribution is preserved in [NOTICE](./NOTICE).

## Install

### Universal Installer

Recommended for normal installs and upgrades:

```bash
curl -fsSL https://raw.githubusercontent.com/reddb-io/red-skills/v2/scripts/install.sh | bash
```

The installer resolves the latest GitHub Release, stores it under
`~/.red-skills/versions/<tag>`, updates `~/.red-skills/current`, detects which
supported CLIs are present (`claude`, `codex`, `opencode`, `pi`), then installs
the right surface for each host:

| Host | What the installer does |
| --- | --- |
| Claude Code | Registers the RedSkills marketplace and installs `dev`, `memory`, and `brain`. |
| Codex CLI | Registers the RedSkills marketplace and installs `dev`, `memory`, and `brain`. |
| Gemini CLI | Registers the RedSkills marketplace and installs `dev`, `memory`, and `brain`. |
| OpenCode | Generates and installs OpenCode plugin modules, skills, MCP config, provider config, and TUI attention config. |
| Pi | Registers one Pi package per plugin via `pi install`, exposes the same skill buckets through the standard agent skills protocol. |

OpenCode installs use the published `opencode-host.bundle.min.mjs` asset when
available, so normal installs need `node` but do not need a local workspace
build. If that asset is unavailable for a pinned older release, the installer
falls back to building from source with `pnpm`.

Useful options:

```bash
# inspect without writing
curl -fsSL https://raw.githubusercontent.com/reddb-io/red-skills/v2/scripts/install.sh | bash -s -- --dry-run

# install only one host
curl -fsSL https://raw.githubusercontent.com/reddb-io/red-skills/v2/scripts/install.sh | bash -s -- --only opencode
curl -fsSL https://raw.githubusercontent.com/reddb-io/red-skills/v2/scripts/install.sh | bash -s -- --only pi

# pin a release
curl -fsSL https://raw.githubusercontent.com/reddb-io/red-skills/v2/scripts/install.sh | bash -s -- --version v2.6.0

# force plugin reinstall where the host supports removal
curl -fsSL https://raw.githubusercontent.com/reddb-io/red-skills/v2/scripts/install.sh | bash -s -- --force

# uninstall from every detected host
curl -fsSL https://raw.githubusercontent.com/reddb-io/red-skills/v2/scripts/install.sh | bash -s -- --uninstall

# uninstall and remove the ~/.red-skills release cache
curl -fsSL https://raw.githubusercontent.com/reddb-io/red-skills/v2/scripts/install.sh | bash -s -- --uninstall --purge
```

After installing, restart any already-open CLI sessions so they reload plugin
manifests. Then run `/red-setup` in a project from Claude Code or
OpenCode, or `$dev:red-setup` in Codex when the client exposes
namespace-qualified skills.

### Manual: Claude Code

```text
/plugin marketplace add reddb-io/red-skills
/plugin install dev@red-skills
/plugin install memory@red-skills
/plugin install brain@red-skills
```

Common `dev` commands become native slash commands:

```text
/red-setup
/triage
/afk --once
/go "one concrete demand"
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

Upgrade or remove:

```text
/plugin marketplace update red-skills
/plugin uninstall brain@red-skills
/plugin uninstall memory@red-skills
/plugin uninstall dev@red-skills
/plugin marketplace remove red-skills
```

### Manual: Codex CLI

```bash
codex plugin marketplace add reddb-io/red-skills
codex plugin marketplace upgrade red-skills
codex plugin add dev@red-skills
codex plugin add memory@red-skills
codex plugin add brain@red-skills
codex plugin marketplace remove red-skills
```

Codex invokes skills with `$<skill>`. Some clients expose plugin skills with
the plugin namespace; use that form when it appears in the skills list:

```text
$dev:red-setup
$dev:triage
$dev:afk --once
$dev:retake #123
$memory:init
$memory:recall cache TTL
$brain:capture Save this project note...
```

Codex currently supports built-in footer items through `tui.status_line`, not a
command-backed statusline. Use `$dev:afk monitor` when the client exposes
namespace-qualified skills, or `$afk monitor` when it exposes unqualified skill
names.

### Manual: Gemini CLI

Gemini CLI support requires installing from a local path or using the native marketplace setup script when released. For local setups, run from a checkout:

```bash
gemini plugin install ./plugins/dev
gemini plugin install ./plugins/memory
gemini plugin install ./plugins/brain
```

Or you can use the global marketplace flow if registered:

```bash
gemini plugin marketplace add reddb-io/red-skills
gemini plugin install dev@red-skills
gemini plugin install memory@red-skills
gemini plugin install brain@red-skills
```

Gemini invokes skills natively and requires loading skills ahead of tool calls (see `activate_skill`). Common commands:

```text
/red-setup
/triage
/afk --once
```

### Codex Manifest Maintenance

Codex manifests are generated artifacts. Do not hand-edit
`.agents/plugins/marketplace.json` or `plugins/*/.codex-plugin/plugin.json`.
Change the Claude-side marketplace/plugin manifests or plugin tree, then run:

```bash
pnpm codex:manifests
pnpm gemini:manifests
```

CI runs `pnpm codex:manifests:check` and `pnpm gemini:manifests:check` and fails when committed Codex or Gemini manifests
drift from the generator output.

### Pi Manifest Maintenance

Pi ships two generated artifacts that must stay in sync with the Claude-side
plugin tree:

- `plugins/<name>/package.json` — the local-path install surface (ADR 0075-era
  shape; consumed by `pi install <path>`).
- `packaging/pi/<name>/package.json` plus `packaging/pi/<name>/skills/` — the
  npm publish surface (ADR 0110; consumed by `pi install npm:@reddb-io/red-skills-<plugin>`).

Both are generated. Do not hand-edit either. Change the Claude-side plugin
manifest or the plugin tree, then run:

```bash
pnpm pi:manifests        # regenerates plugins/<name>/package.json
pnpm pi:packages:build   # stages packaging/pi/<name>/ from plugins/<name>/
```

CI runs both `pnpm pi:manifests:check` and `pnpm pi:packages:check` and fails
when either committed artifact drifts. The release pipeline runs the build
step before publishing, so a manual regeneration is only required when working
on Pi support itself.

### Manual: OpenCode

OpenCode support is generated from the same plugin source tree as Claude Code
and Codex. The installer writes skills, plugin modules, MCP config, provider
config, and TUI attention config for OpenCode. The universal installer above is
preferred for normal user-scoped installs; use the direct script when developing
or when installing/removing a checkout in a specific project.

```bash
git clone git@github.com:reddb-io/red-skills.git ~/code/red-skills
cd ~/code/red-skills

# user-scoped install into ~/.config/opencode
scripts/install-opencode.sh --global

# user-scoped uninstall from ~/.config/opencode
scripts/install-opencode.sh --uninstall --global

# project-local install into the current repo
scripts/install-opencode.sh

# project-local uninstall from the current repo
scripts/install-opencode.sh --uninstall

# inspect without writing
scripts/install-opencode.sh /path/to/project --dry-run
```

Then run OpenCode in any configured project:

```bash
opencode .
```

Use `/connect` inside OpenCode or export one of `OPENAI_API_KEY`,
`MINIMAX_API_KEY`, or `OPENROUTER_API_KEY`. Generated config never stores auth
secrets. Details live in [apps/opencode-host](./apps/opencode-host/README.md).

### Manual: Pi

RedSkills ships one Pi package per published plugin on npm under the
`@reddb-io` scope. The packages are generated from the same Claude-side
manifests the other hosts consume, so the same skill buckets (`engineering`,
`knowledge`, `productivity`, `misc`, `core`) Claude Code and Codex already
expose are what Pi discovers.

The natural install is the same one-liner Pi documents for every npm package:

```bash
pi install npm:@reddb-io/red-skills-dev
pi install npm:@reddb-io/red-skills-memory
pi install npm:@reddb-io/red-skills-brain
# (optional) maintainer-only — gated by plugins.internal.enabled: true
pi install npm:@reddb-io/red-skills-internal
```

Updates follow the rest of the release train: `pi update --all` resolves the
latest matching version from the npm registry and the new skills reload on the
next session start.

For repo-scoped installs that ship with the project (so teammates pick up the
same RedSkills surface on first launch), use the bundled installer:

```bash
# user-scoped install into ~/.pi/agent/settings.json (npm: surface)
scripts/install-pi.sh

# project-scoped install into <repo>/.pi/settings.json
scripts/install-pi.sh --project /path/to/your-project

# pin a specific published version (e.g. before a tagged release)
RED_SKILLS_PI_VERSION=2.75.2 scripts/install-pi.sh

# dev path: install from a local checkout (in-repo workflow)
scripts/install-pi.sh --source-dir /path/to/red-skills-checkout

# user-scoped uninstall
scripts/install-pi.sh --uninstall

# dry-run + inspect
scripts/install-pi.sh --project . --dry-run
```

`scripts/install-pi.sh` writes `~/.pi/agent/redskills-install-manifest.json` (or
`<project>/.pi/redskills-install-manifest.json` for `--project`) recording each
`npm:` spec it registered, so a subsequent `--uninstall` cleanly tears down
exactly that surface. The `--source-dir` form records local-path specs in the
same manifest under a separate `source` discriminator.

Known limitations versus the other hosts:

- Pi does not run lifecycle hooks, so the Codex/Claude `SessionStart`/`Stop`
  hooks (the rsp interception bridge, red-fetch, command-guard, branch-lock,
  statusline wiring) are not active in Pi. Skills that depend on those hooks
  lose telemetry but stay navigable; AFK runners and `navigator` MCP servers are
  unaffected.
- Two plugins (`memory` and `brain`) ship a skill with the same `name: view`.
  Pi warns on duplicate skill names and keeps the first one registered, so
  install `memory` or `brain` last depending on which `view` you want as the
  primary entry point.
- Pi does not advertise the plugin display metadata Codex uses; the npm
  `description` field is the only user-visible summary in `pi list`.
- The `internal` package is gated by `plugins.internal.enabled: true`
  (ADR 0067) the same way the Claude and Codex marketplaces expose it. The npm
  package is public; the gate is what keeps it inactive in non-maintainer
  repos.

After installing, restart any open Pi session so the new skills reload.
`scripts/install-pi.sh --help` documents the user/project scope split, the
`--source-dir` dev path, and the `--uninstall` flow.

### No Marketplace

Older agents, local hacking, or Gemini-style skill loading can install from a
checkout:

```bash
npx skills@latest add reddb-io/red-skills
```

For local symlinks:

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

---

## What Makes It Different

**Issue to PR is the product.** RedSkills treats GitHub Issues as the work
queue, not a side note. `/triage`, `/to-spec`, `/to-tickets`, `/afk`, `/go`,
`/hitl`, and `/retake` all speak the same issue-state vocabulary.

**Agents work in disposable worktrees.** AFK execution and interactive landing
keep the primary checkout under human branch control. Work is prepared,
validated, committed, pushed, reviewed, and merged through explicit gates.

**Memory is evidence, not vibes.** The Memory plugin stores decisions, root
causes, validation records, reasoning attempts, supersession, freshness, and
readiness signals so future agents can verify old claims before acting.

**Brain is for human-facing knowledge.** Brain captures project notes, personal
facts, sources, questions, bookmarks, typed artifacts, and cited synthesis under
`.red/brain/*`.

**One source tree, several hosts.** Claude Code, Codex, OpenCode, GitHub Actions,
and MCP servers are generated from the same plugin definitions and runtime apps.

---

## The Loop

```text
Plan -> Spec -> sliced issues -> ready-for-agent -> isolated worktree
  -> validation -> PR -> review/checks -> merge -> Memory evidence
```

The issue lifecycle is intentionally boring:

```text
needs-triage -> /triage -> ready-for-agent -> /afk -> PR/merge -> closed
                                |
                                +---- blocked/spec/validation/etc.
                                      -> ready-for-human -> /hitl or /retake
```

Important states:

| State | Meaning |
| --- | --- |
| `ready-for-agent` | The only issue state AFK consumes. |
| `running` | Timeline state while a worker owns the issue. Live state is local. |
| `ready-for-human` | A human decision is needed before delegation is safe. |
| `blocked:dependency` | Waits on `req:N` labels and should not page a human. |
| `blocked:validation` / `blocked:spec` | Can be requeued only after retry guidance is already decided. |

## What Ships

| Plugin | Job | Use it when |
| --- | --- | --- |
| [`dev`](./plugins/dev/.claude-plugin/plugin.json) | Engineering workflow: issue triage, AFK execution, worktree safety, review-gated landing, process dashboards, runner policy, and codebase orientation. | You want an agent to plan, execute, review, or ship code work. |
| [`memory`](./plugins/memory/README.md) | Governed operational memory: decisions, validations, reasoning attempts, stale-claim checks, context packs, and skill telemetry evidence. | You want agents to stop repeating old mistakes after context resets. |
| [`brain`](./plugins/brain/README.md) | Project-local knowledge: typed artifacts, personal/project facts, sources, graph connections, search, cited answers, and dashboards. | You want durable knowledge the human may ask about later. |

Maintainer-only plugin:

| Plugin | Job | Use it when |
| --- | --- | --- |
| [`internal`](./plugins/internal/README.md) | Maintainer-only skills for operating this repository. Installable through the normal marketplace flow, but active only when `plugins.internal.enabled: true` is present. | You maintain `red-skills` itself. |

The short version:

- **Dev moves work.**
- **Memory improves agent execution.**
- **Brain preserves human-facing knowledge.**

## Quick Start

### 1. Bootstrap A Repo

Run this inside a target repository:

```text
/red-setup
```

It creates and wires the RedSkills operating surface:

- `.red/config.yaml` with explicit `plugins.<name>.enabled: true` flags.
- GitHub issue labels such as `needs-triage`, `ready-for-agent`,
  `ready-for-human`, `running`, `blocked:*`, `blocked:dependency`, and `req:N`.
- Domain docs under `.red/CONTEXT-MAP.md`, `.red/contexts/*/CONTEXT.md`, and
  ADRs under `.red/adr/`.
- `AGENTS.md` / `CLAUDE.md` blocks for agent skills and the development
  workflow.
- RedSkills workflows such as `red-issues-needs-triage.yml`.
- Optional statusline wiring and primary-checkout branch guardrails.

Re-run `/red-setup` when adoption drifts. Run `/red-doctor` to inspect drift
and operational probes without changing anything, or `/red-doctor --fix` for the
approved, per-finding gated repair path.

### 2. Move Work Through Issues

```text
/start                  # sharpen a plan against domain language and ADRs
/wayfinder              # map work too large for one agent session
/to-spec                 # publish the plan as a Spec issue
/to-tickets <spec>        # cut vertical implementation slices
/triage                 # make an issue delegable
/afk                    # drain ready-for-agent work in isolated worktrees
```

Shortcuts:

- Already have a delegable issue? Use `/afk --issues N`.
- Already have a spec? Use `/to-tickets` or `/triage`.
- Hit a bug? Use `/report-bug`, then `/triage`.
- Something is urgent? Label the issue `priority:urgent`; the `/afk` queue
  promotes it ahead of every `--spec` / `--issues` filter.

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

## Host Support

| Host | Surface | Notes |
| --- | --- | --- |
| Claude Code | Marketplace plugins, slash commands, skills, hooks, MCP servers | Primary interactive host. |
| Codex CLI | Marketplace plugins, `$skill` invocation, MCP servers, footer integration | Namespace-qualified skill names may appear depending on client version. |
| Gemini CLI | Marketplace plugins, skills, hooks, MCP servers | Fully natively supported via generated manifests. |
| OpenCode | Generated `.opencode/skills`, plugin modules, MCP config, provider config, TUI attention config | Installed through `scripts/install-opencode.sh`. |
| Pi | One npm-published package per plugin (`@reddb-io/red-skills-<plugin>` on npm, staged under `packaging/pi/<name>/`) carrying the shared skill buckets | Installed through `pi install npm:@reddb-io/red-skills-<plugin>`, or via `scripts/install-pi.sh` for repo-scoped installs and the `--source-dir` dev path. |
| GitHub Actions | Reusable AFK attempt workflow and composable action | Runs one AFK attempt per issue in adopter repos. |

## Plugin Boundaries

### Dev

<img src="docs/plugin-dev.svg" alt="dev plugin - issue pipeline, AFK runtime, landing, and codebase orientation" width="100%" />

`dev` owns the engineering workflow: issue pipeline, AFK runtime, interactive
landing, process visibility, setup/adoption checks, codebase orientation, and
the [`navigator` MCP server](./apps/code-nav/README.md).

Core responsibilities:

- Bootstrap RedSkills with [`red-setup`](./plugins/dev/skills/engineering/red-setup/SKILL.md).
- Maintain issue state with [`triage`](./plugins/dev/skills/engineering/triage/SKILL.md), [`to-spec`](./plugins/dev/skills/engineering/to-spec/SKILL.md), and [`to-tickets`](./plugins/dev/skills/engineering/to-tickets/SKILL.md).
- Execute delegable work with [`afk`](./plugins/dev/skills/engineering/afk/SKILL.md), or dispatch one concrete demand with [`go`](./plugins/dev/skills/engineering/go/SKILL.md).
- Land a hand-worked branch with [`retake`](./plugins/dev/skills/engineering/retake/SKILL.md) (the retired `ship` migrated there — ADR 0081).
- Resolve human gates with [`hitl`](./plugins/dev/skills/engineering/hitl/SKILL.md) or safe retries with [`retake`](./plugins/dev/skills/engineering/retake/SKILL.md).

Dev guard rails:

- When `plugins.dev.enabled: true`, the dev PreToolUse proxy enforces the
  worktree boundary for agent shell commands: `git worktree add` must target a
  registered lane under `.red/tmp/`, and branch-moving commands in the primary checkout
  (`git switch`, `git checkout <branch>`, `git checkout -b`, `git switch -c`,
  `gh pr checkout`) are blocked. Create branches through
  `git worktree add .red/tmp/worktrees/manual/<slug> -b <branch> ...` instead.
- `plugins.dev.lock.primary-branch` remains the explicit branch-lock workflow
  flag that setup writes for compatibility and base-pinning integrations.
- The dev shell-command guard is controlled by `command_guard` in
  `.red/config.yaml`. It runs from the agent `PreToolUse` hook, stays inert
  unless `plugins.dev.enabled: true`, and blocks matching shell commands before
  execution. These repo-defined rules are **additional** to the built-in
  `.red/tmp` worktree boundary above. `global` rules apply everywhere, `main`
  rules apply in the primary session scope (not specifically the Git branch
  named `main`), and `worktree` rules apply in `/afk` and `/go` worktrees
  under `.red/tmp/`. Deny rules
  support `regex:<pattern>`, `prefix:<literal>`, `suffix:<literal>`,
  `exact:<literal>`, and `glob:<pattern>`. Bare entries with `*`, `?`, or `[`
  are Bash globs; other bare entries match the exact command, a command prefix,
  or a command suffix at a shell-command boundary. `command_guard.deny` remains
  a legacy alias for `command_guard.global`.

Example policy, not a default:

```yaml
command_guard:
  global:
    - "rm -Rf /*"
    - "git stash"
    - sudo
    - 'regex:(^|[;&|[:space:]])curl[[:space:]].*\|[[:space:]]*sh'
  main:
    - "git rebase"
    - "git checkout -b"
  worktree:
    - "git clean"

plugins:
  dev:
    enabled: true
```

### Memory

<img src="docs/plugin-memory.svg" alt="memory plugin - governed evidence that makes the next agent safer and faster" width="100%" />

`memory` is governed operational memory for code agents. It stores work
evidence that can make future agents safer and faster: decisions, root causes,
validation evidence, reasoning attempts, stale-claim checks, readiness,
handoffs, and skill telemetry evidence.

Memory modes:

| Mode | Storage | Best for |
| --- | --- | --- |
| `markdown-only` | Plain notes under `.red/memory/notes/`. | Low-risk rollout with explicit store/recall only. |
| `graph` | Project-local RedDB store at `.red/memory/graph.rdb`. | Governed recall, provenance, supersession, readiness, context packs, Workbench, MCP/HTTP, and Skill telemetry. |

Memory is not the Personal-fact store. Personal facts belong in Brain, not Memory.
Broad human-facing project knowledge belongs in Brain too.

Start with [plugins/memory/README.md](./plugins/memory/README.md).

### Brain

<img src="docs/plugin-brain.svg" alt="brain plugin - project-local knowledge, cited synthesis, and a local dashboard" width="100%" />

`brain` is a project-local knowledge repository under `.red/brain/*`. It stores
typed artifacts and graph connections for later search and cited synthesis.

Use Brain for:

- Personal facts, durable preferences, identity context, and relationship notes.
- Project notes, decisions, ideas, questions, sources, bookmarks, and meeting
  residue.
- `brain think` cited answers with confidence and missing-evidence signals.
- `brain dashboard` local summaries and KPI-style views.
- Optional outbound channel actions through the Brain channel bridge.

Start with [plugins/brain/README.md](./plugins/brain/README.md).

## GitHub Actions Lane

The AFK Actions lane runs one AFK attempt per issue from GitHub Actions. It is
for adopter repos that want cloud execution without a local fleet.

| Layer | Artifact | Job |
| --- | --- | --- |
| Trigger + policy | [`reusable-afk-attempt.yml`](./.github/workflows/reusable-afk-attempt.yml) | `workflow_call`, manual dispatch, and trust gate. |
| Execution | [`.github/actions/afk-attempt`](./.github/actions/afk-attempt/action.yml) | Sets up Node, runner CLI, auth env, and invokes the AFK launcher. |
| Runtime distribution | `afk.mjs` + the `@reddb-io/red-skills` npm package | Resolves the versioned `dev` bundle matching the checked-out red-skills ref via npm (ADR 0091), cache-first. |

Adoption paths:

- **Turnkey caller:** install or copy an `rs-afk-attempt.yml` caller that wires
  issue/manual triggers to
  `reddb-io/red-skills/.github/workflows/reusable-afk-attempt.yml@v2`.
- **Composable action:** use
  `reddb-io/red-skills/.github/actions/afk-attempt@v2` from your own workflow.

Pin `@v2` to track the latest compatible v2 release. Pin a SHA when the caller
needs a fully immutable action/runtime pair.

Workflow naming convention:

| Prefix | Meaning |
| --- | --- |
| `reusable-*` | Reusable `workflow_call` workflow referenced by `uses:`; never copied into adopters. |
| `rs-*` | A caller that instantiates a `reusable-*` workflow with concrete triggers/inputs. |
| `red-*` | Standalone RedSkills workflow; internal CI or verbatim copy-installable. |

Full guide: [AFK Actions lane](./plugins/dev/skills/engineering/afk/actions-lane.md).

## Repo Layout

| Path | Purpose |
| --- | --- |
| [`plugins/dev`](./plugins/dev) | Plugin definition, skills, hooks, scripts, MCP config, and docs for engineering workflow. |
| [`plugins/memory`](./plugins/memory) | Plugin definition and skills for governed operational memory. Runtime source lives in `apps/memory`. |
| [`plugins/brain`](./plugins/brain) | Plugin definition and skills for Brain. Runtime source lives in `apps/brain`. |
| [`plugins/internal`](./plugins/internal) | Maintainer-only plugin definition and skills for operating this repository. |
| [`apps/dev`](./apps/dev) | AFK, landing, dashboard, triage, runner, release/channel, and workflow runtime code. |
| [`apps/memory`](./apps/memory) | Memory CLI, graph operations, Workbench, MCP/HTTP surfaces, evals, and diagnostics. |
| [`apps/brain`](./apps/brain) | Brain CLI, store, MCP server, dashboard, channel bridge, and artifact logic. |
| [`apps/code-nav`](./apps/code-nav) | LSP-backed MCP server used by the `dev` plugin. |
| [`apps/opencode-host`](./apps/opencode-host) | Adapter that emits OpenCode config, skills, hooks, MCP passthrough, and statusline/toast integration. |
| [`apps/red-browser`](./apps/red-browser) | Browser CLI: opens a local annotation bridge for HTML artifacts, long-polls human feedback, and enforces the layout-audit gate. |
| [`packages/shared`](./packages/shared) | Shared runtime helpers for plugin gates, bundle fetching, args, logging, and channels. |
| [`packages/browser-bridge`](./packages/browser-bridge) | Local CLI-to-browser annotation bridge: injects an annotation SDK into HTML artifacts and long-polls for human feedback and layout-audit results. |
| [`packages/cdp-driver`](./packages/cdp-driver) | CDP-based live-app driver for `red-browser`: connects to Chrome via DevTools Protocol, captures a11y-tree snapshots, and streams console/network events. |
| [`packages/build-info`](./packages/build-info) | Shared runtime build metadata helpers consumed by bundled apps. |
| [`packages/red-castle`](./packages/red-castle) | AFK execution substrate (vendored submodule, `@reddb-io/red-castle`): sandcastle fork that owns per-attempt worktree isolation, agent spawning, and signal detection. |
| [`packaging/npm`](./packaging/npm) | The publishable `@reddb-io/red-skills` npm package (outside the pnpm workspace): built plugin bundles plus the three `red-skills-*` bin shims. The v2 client transport (ADR 0091). |
| [`.red`](./.red) | RedSkills' own project configuration: context map, glossaries, ADRs, issue-tracker docs, and agent rules. |
| [`.github/workflows`](./.github/workflows) | Release, CI, upstream watch, issue automation, PR review, and reusable AFK attempt workflows. |

Installed plugin trees are definitions and launchers. Runtime bundles are built
from `apps/*` and shipped inside the [`@reddb-io/red-skills`](./packaging/npm)
npm package (ADR 0091) — one tarball carrying the `dev`, `memory`, and `brain`
JS bundles plus the `red-skills-dev` / `red-skills-memory` / `red-skills-brain`
bin shims. Session-start launchers resolve the version-pinned package via npm
(`npx -y @reddb-io/red-skills@<pin>` semantics), cache-first, and integrity is
npm's own tarball shasum — no GitHub-release download and no client-side
signature step. The Memory/Brain native `red` engine binary is the one
per-platform artifact that cannot ride in the tarball; those plugins resolve it
separately at runtime.

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

Operator-declared pre-merge checks (backpressure):

```yaml
plugins:
  dev:
    afk:
      backpressure:
        - pnpm lint
        - cargo fmt --check
```

`afk.backpressure` is an ordered list of shell commands run in the worker-branch
worktree after the implicit feedback gate (test/typecheck/lint/build) passes on
the DONE path. Any non-zero command blocks the merge and parks the issue exactly
like a feedback failure. When the list is non-empty, every executed check — pass
and fail alike — is also rendered as a single aggregated, non-blocking `COMMENT`
PR review, so the PR carries a legible evidence ledger without adding a new gate.

House rules:

- Labels are kebab-case or `prefix:value`: `needs-triage`, `ready-for-agent`,
  `ready-for-human`, `priority:urgent`, `blocked:dependency`, `spec:42`.
- RedSkills-managed workflows use role prefixes: `red-*`, `reusable-*`, or
  `rs-*`.
- Issues and Specs live on GitHub Issues.
- Project artifacts live under `.red/`.
- Use SSH git remotes for AFK-managed repositories.
- Do task work in isolated worktrees; the primary checkout's branch is for the
  human to control.

## Skill Map

This is a map, not a replacement for the skill files. Open the linked
`SKILL.md` before using a skill in a new context.

| Area | Skills |
| --- | --- |
| Dev setup and issue flow | [`ask-red`](./plugins/dev/skills/engineering/ask-red/SKILL.md), [`red-setup`](./plugins/dev/skills/engineering/red-setup/SKILL.md), [`red-doctor`](./plugins/dev/skills/engineering/red-doctor/SKILL.md), [`start`](./plugins/dev/skills/engineering/start/SKILL.md), [`wayfinder`](./plugins/dev/skills/engineering/wayfinder/SKILL.md), [`to-spec`](./plugins/dev/skills/engineering/to-spec/SKILL.md), [`to-tickets`](./plugins/dev/skills/engineering/to-tickets/SKILL.md), [`triage`](./plugins/dev/skills/engineering/triage/SKILL.md), [`report-bug`](./plugins/dev/skills/engineering/report-bug/SKILL.md) |
| Dev execution and landing | [`afk`](./plugins/dev/skills/engineering/afk/SKILL.md), [`go`](./plugins/dev/skills/engineering/go/SKILL.md), [`manager`](./plugins/dev/skills/engineering/manager/SKILL.md), [`implement`](./plugins/dev/skills/engineering/implement/SKILL.md), [`tdd`](./plugins/dev/skills/engineering/tdd/SKILL.md), [`verify`](./plugins/dev/skills/engineering/verify/SKILL.md), [`ground-truth`](./plugins/dev/skills/engineering/ground-truth/SKILL.md), [`diagnose`](./plugins/dev/skills/engineering/diagnose/SKILL.md), [`hitl`](./plugins/dev/skills/engineering/hitl/SKILL.md), [`retake`](./plugins/dev/skills/engineering/retake/SKILL.md), [`resolving-merge-conflicts`](./plugins/dev/skills/engineering/resolving-merge-conflicts/SKILL.md) |
| Dev operations and understanding | [`dashboard`](./plugins/dev/skills/engineering/dashboard/SKILL.md), [`audit-skills`](./plugins/dev/skills/engineering/audit-skills/SKILL.md), [`daily-review`](./plugins/dev/skills/engineering/daily-review/SKILL.md), [`red-gains`](./plugins/dev/skills/engineering/red-gains/SKILL.md), [`context`](./plugins/dev/skills/engineering/context/SKILL.md), [`zoom-out`](./plugins/dev/skills/engineering/zoom-out/SKILL.md), [`improve-codebase-architecture`](./plugins/dev/skills/engineering/improve-codebase-architecture/SKILL.md), [`adr-editor`](./plugins/dev/skills/engineering/adr-editor/SKILL.md), [`model-tier-policy`](./plugins/dev/skills/engineering/model-tier-policy/SKILL.md), [`red-statusline`](./plugins/dev/skills/engineering/red-statusline/SKILL.md), [`prototype`](./plugins/dev/skills/engineering/prototype/SKILL.md), [`code-review`](./plugins/dev/skills/engineering/code-review/SKILL.md), [`curate`](./plugins/dev/skills/engineering/curate/SKILL.md) |
| Dev knowledge, productivity, and utilities | [`research`](./plugins/dev/skills/knowledge/research/SKILL.md), [`reflect`](./plugins/dev/skills/productivity/reflect/SKILL.md), [`ff`](./plugins/dev/skills/productivity/ff/SKILL.md), [`handoff`](./plugins/dev/skills/productivity/handoff/SKILL.md), [`write-a-skill`](./plugins/dev/skills/productivity/write-a-skill/SKILL.md), [`branch-lock`](./plugins/dev/skills/misc/branch-lock/SKILL.md), [`git-guardrails-claude-code`](./plugins/dev/skills/misc/git-guardrails-claude-code/SKILL.md), [`migrate-to-shoehorn`](./plugins/dev/skills/misc/migrate-to-shoehorn/SKILL.md), [`setup-pre-commit`](./plugins/dev/skills/misc/setup-pre-commit/SKILL.md) |
| Memory | [`init`](./plugins/memory/skills/core/init/SKILL.md), [`store`](./plugins/memory/skills/core/store/SKILL.md), [`recall`](./plugins/memory/skills/core/recall/SKILL.md), [`ingest`](./plugins/memory/skills/core/ingest/SKILL.md), [`extract`](./plugins/memory/skills/core/extract/SKILL.md), [`context-status`](./plugins/memory/skills/core/context-status/SKILL.md), [`skills-status`](./plugins/memory/skills/core/skills-status/SKILL.md), [`health`](./plugins/memory/skills/core/health/SKILL.md), [`improve-skills`](./plugins/memory/skills/core/improve-skills/SKILL.md), [`doctor`](./plugins/memory/skills/core/doctor/SKILL.md), [`export`](./plugins/memory/skills/core/export/SKILL.md), [`view`](./plugins/memory/skills/core/view/SKILL.md), [`wiki-init`](./plugins/memory/skills/core/wiki-init/SKILL.md), [`wiki`](./plugins/memory/skills/core/wiki/SKILL.md) |
| Brain | [`capture`](./plugins/brain/skills/core/capture/SKILL.md), [`search`](./plugins/brain/skills/core/search/SKILL.md), [`think`](./plugins/brain/skills/core/think/SKILL.md), [`status`](./plugins/brain/skills/core/status/SKILL.md), [`view`](./plugins/brain/skills/core/view/SKILL.md) |
| MCP servers | [`castle`](./plugins/dev/skills/engineering/afk/MCP.md), [`navigator`](./apps/code-nav/README.md), [`memory-mcp`](./plugins/memory/.mcp.json), [`brain`](./plugins/brain/.mcp.json) |

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

### Releasing

Releases run on [changesets](https://github.com/changesets/changesets) in two
halves (ADR 0121). **Nothing pushes a commit to `main`** — the version bump is a
reviewed PR like any other.

1. **Land your change with a changeset.** Run `pnpm changeset`, pick
   `patch`/`minor`/`major`, describe the change in one consumer-facing line, and
   commit the generated file under `.changeset/`. A change that ships without
   one accumulates no bump and never releases.
2. **[red-release.yml](./.github/workflows/red-release.yml) maintains the Version
   Packages PR.** On every push to `main` it collects the pending changesets and
   opens/updates a `chore(release): version packages` PR. That PR runs
   `pnpm release:version` — `changeset version` plus
   [`scripts/sync-version.mjs`](./scripts/sync-version.mjs), the single writer
   (ADR 0040) that carries the version into the root `package.json`, the Claude
   and Codex plugin manifests, and the Pi manifests. `pnpm version:sync:check`
   fails CI if any of them drifts.
3. **Merging that PR cuts the tag.** `main` now has no pending changesets and a
   version no tag points at, so `red-release.yml` tags `vX.Y.Z`.
4. **[red-publish.yml](./.github/workflows/red-publish.yml) publishes the tag.**
   It builds the bundles, stages them into the `@reddb-io/red-skills` npm
   package, runs the real packaged client against the packed tarball as a
   producer/consumer contract check, `npm publish`es, smokes the published
   package from the registry, cuts the GitHub Release with the assets, and moves
   the matching major tag such as `v2` so reusable workflows pinned to `@v2`
   keep advancing.

The `publish` job runs in the GitHub environment named `red-release`. Repository
settings must keep that environment protected with required reviewers, because
approval is the gate before the job publishes release assets or moves the major
tag. Once an approved reviewer approves the environment deployment, the publish
continues without any extra manual step.

Publishing defers while any open issue carries the `running` label (an `/afk`
fleet is mid-iteration); an hourly schedule retries the newest tag that has no
GitHub Release yet, and every stage is idempotent so the retry resumes rather
than conflicts.

## License

Apache-2.0. See [LICENSE](./LICENSE). See [NOTICE](./NOTICE) for upstream MIT
attribution and bundled runtime notices.
