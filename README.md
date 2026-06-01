<div align="center">

```
   ██████╗ ███████╗██████╗     ███████╗██╗  ██╗██╗██╗     ██╗     ███████╗
   ██╔══██╗██╔════╝██╔══██╗    ██╔════╝██║ ██╔╝██║██║     ██║     ██╔════╝
   ██████╔╝█████╗  ██║  ██║    ███████╗█████╔╝ ██║██║     ██║     ███████╗
   ██╔══██╗██╔══╝  ██║  ██║    ╚════██║██╔═██╗ ██║██║     ██║     ╚════██║
   ██║  ██║███████╗██████╔╝    ███████║██║  ██╗██║███████╗███████╗███████║
   ╚═╝  ╚═╝╚══════╝╚═════╝     ╚══════╝╚═╝  ╚═╝╚═╝╚══════╝╚══════╝╚══════╝
```

### Ship code while the agent remembers why.

RedSkills is reddb.io's agent workflow kit for Claude Code, Codex, and any agent that can read `SKILL.md` files.

It ships as two plugins:

| Plugin | Job | Use it when... |
|--------|-----|----------------|
| **`dev`** | Turns plans and GitHub issues into reviewed, tested PRs. | You want `/start`, `/to-prd`, `/to-issues`, `/triage`, `/tdd`, `/diagnose`, `/wiki`, and the autonomous `/afk` loop. |
| **`memory`** | Gives those agents governed operational memory. | You want decisions, gotchas, validations, provenance, claim checks, readiness, context packs, and handoffs to survive `/clear`. |

**Install both in Claude Code:**

```
/plugin marketplace add reddb-io/red-skills && /plugin install dev@red-skills && /plugin install memory@red-skills
```

[Install](#install) · [Two plugins](#two-plugins-one-workflow) · [Memory](#memory--governed-operational-memory) · [Pipeline](#-the-pipeline-that-feeds-it) · [Reference](#reference)

```
   dev plugin                                      memory plugin
   ──────────                                      ─────────────

   /start ─▶ /to-prd ─▶ /to-issues ─▶ /triage ─▶ /afk
     │                                              │
     └────────────── stores what mattered ─────────▶│
                                                    ▼
                       init ─▶ store ─▶ recall ─▶ verify ─▶ handoff
```

**The punchline:** `dev` does the work. `memory` keeps the next agent from starting cold.

**Highlights**

- Fleet mode for draining real GitHub issue queues with Claude or Codex.
- Safe git guardrails, live monitors, statusline, and `.red/config.yaml` detectors.
- Governed memory over markdown notes or a project-local RedDB graph.
- Recall, claim-check, readiness, context-pack, handoff, Workbench, MCP, and HTTP surfaces.

</div>

> A reddb.io adaptation of [`mattpocock/skills`](https://github.com/mattpocock/skills) — same DNA, adapted for our reality, with an autonomous loop layered on top. Massive thanks to [@mattpocock](https://github.com/mattpocock); the original lives at [aihero.dev](https://www.aihero.dev/s/skills-newsletter). We pin upstream via `.upstream` and a daily workflow (`red-upstream-watch.yml`) opens an issue when it advances, so we cherry-pick what's worth taking.

---

## Two plugins, one workflow

RedSkills is not a bag of prompts. It is a small operating system for agentic engineering work.

| Layer | Plugin | What it owns | First command |
|-------|--------|--------------|---------------|
| Work execution | `dev` | Planning, PRDs, issue slicing, triage, TDD, diagnosis, wiki, codebase orientation, and `/afk` workers. | `/setup-red-skills` |
| Work memory | `memory` | Durable decisions, gotchas, reasoning traces, validations, provenance, supersession, claim checks, readiness, and handoff context. | `memory init` or `$init` |

Use `dev` when you want an agent to move the repo forward. Add `memory` when you want that movement to compound instead of evaporating after every session.

The intended loop is simple:

```text
Plan with dev        /start -> /to-prd -> /to-issues
Queue with dev       /triage -> ready-for-agent
Execute with dev     /afk -> test -> merge -> close
Remember with memory store -> recall -> claim-check/readiness -> handoff
```

`memory` depends on `dev` because memory is most valuable when it is attached to real work: issues, attempts, validations, code changes, and decisions an agent will need later.

---

## Install

### Claude Code — marketplace install

RedSkills ships as a Claude Code **plugin marketplace** with two plugins. Install `dev` for the engineering workflow. Install `memory` as well when you want governed memory, lifecycle hooks, Workbench diagnostics, and context handoff.

Inside Claude Code:

```
/plugin marketplace add reddb-io/red-skills
/plugin install dev@red-skills
/plugin install memory@red-skills
```

Use `dev` skills as native slash commands:

```text
/setup-red-skills
/triage
/afk --once
```

Use `memory` through its skills and CLI-backed command surface:

```text
$init
$store Decision: retries use exponential backoff with jitter.
$recall retry policy
```

From now on Claude Code checks `reddb-io/red-skills` at session start. Toggle the behaviour with `/plugin` -> **Marketplaces** -> select `red-skills` -> **Enable auto-update**.

Force a refresh without restarting:

```
/plugin marketplace update red-skills
```

Remove:

```
/plugin uninstall memory@red-skills
/plugin uninstall dev@red-skills
/plugin marketplace remove red-skills
```

> ℹ️ Every push to `main` cuts a patch release on GitHub. New commits land on auto-update users at their next session — no action needed from them.

### Codex CLI — marketplace install

RedSkills also ships Codex plugin metadata for both `dev` and `memory`. Codex reads `.agents/plugins/marketplace.json`, then loads the plugin trees through `plugins/*/.codex-plugin/plugin.json`. `dev` is installed by default; `memory` is available and declares a dependency on `dev`.

```bash
codex plugin marketplace add reddb-io/red-skills
```

Use the skills by name in Codex prompts. The convention is `$<skill>`:

```text
$setup-red-skills
$triage
$afk --once
$init
$store Decision: retries use exponential backoff with jitter.
$recall retry policy
```

Refresh later:

```bash
codex plugin marketplace upgrade red-skills
```

That upgrade refreshes the installed Codex plugin metadata, the skills tree, the
bundled hook manifests, and supporting files such as MCP/app definitions. On
the first Codex boot after installing or upgrading a marketplace that ships
hooks, Codex will ask you to revisit the plugin hooks before they run. Current
Codex builds list `plugin_hooks` as stable and enabled; older builds may require
this in `~/.codex/config.toml`:

```toml
[features]
plugin_hooks = true
```

Remove:

```bash
codex plugin marketplace remove red-skills
```

For Codex installs pinned to a local checkout, pass the local repo root instead:

```bash
codex plugin marketplace add ~/code/red-skills
```

### Verify Claude + Codex compatibility

Run this before a release or after upgrading either CLI:

```bash
./scripts/doctor-runners.sh
```

It validates the install metadata, checks shell syntax, verifies the Claude and Codex runner flags that `/afk` depends on, tests Codex marketplace registration in a temporary home directory, and checks manual symlink installs for all local agent skill directories.

### AFK runner and model config

`/afk` is runner-portable, but the invoking LLM must identify its own host runner when it calls the bundle: Codex uses `RED_AFK_RUNNER=codex`; Claude Code uses `RED_AFK_RUNNER=claude`. Do not choose a different runner just because another CLI exists on `PATH`.

Project-local AFK settings live in `.red/config.yaml`. Prefer per-runner model config so Codex never receives a Claude-only model:

```yaml
afk:
  models:
    codex: gpt-5.5
    claude: claude-opus-4-8
```

Defaults are runner-specific: Codex defaults to `gpt-5.5`; Claude Code defaults to `claude-opus-4-8`. The legacy `afk.model` key is still accepted as a global override, but per-runner `afk.models.<runner>` is safer for mixed Claude/Codex fleets.

<details>
<summary><strong>Alternatives — no auto-update</strong></summary>

Pick one of these only if the marketplace path doesn't fit (Gemini users, local hacking, or older agents without plugin marketplace support).

#### `npx skills` (Matt's installer)

```bash
npx skills@latest add reddb-io/red-skills
```

[skills.sh](https://skills.sh/reddb-io/red-skills) walks you through which skills to install and which coding agents to install them on. **No auto-update** — re-run the command to pull new versions. Same installer Matt uses for his upstream repo — credit to [@mattpocock](https://github.com/mattpocock).

#### Manual clone + symlinks

For local edits or `$<name>` access from Codex / Gemini CLI:

```bash
git clone git@github.com:reddb-io/red-skills.git ~/code/red-skills
cd ~/code/red-skills
./scripts/link-skills.sh         # symlinks every stable SKILL.md into local agent skill dirs
```

The script links into `~/.claude/skills`, `~/.agents/skills`, and `~/.codex/skills` so Claude Code, current Codex installs, and simple `$<name>` agents see the same working tree. **No auto-update.** Update later with `git pull && ./scripts/link-skills.sh`.

</details>

### Pick your agent

| Agent | Invocation | Notes |
|-------|------------|-------|
| **Claude Code** | `/afk`, `/wiki`, `/triage`, `$init`, `$recall`, ... | Native `dev` slash commands after `/plugin install dev@red-skills`; install `memory@red-skills` for governed memory skills. |
| **Codex CLI** | `$afk`, `$wiki`, `$triage`, `$init`, `$recall`, ... | Skill-name convention after `codex plugin marketplace add reddb-io/red-skills`. |
| **Gemini CLI / others** | `$afk`, `$recall`, etc. | Same `$<name>` convention. Works with any agent that can read local `SKILL.md` files and run bash. |

Teach Codex (or any non-Claude-Code agent) the convention by appending to `~/.codex/AGENTS.md`:

```markdown
## RedSkills

When the user types `$<name>` (e.g. `$afk`, `$wiki`, `$triage`), look up
`~/.agents/skills/<name>/SKILL.md`, `~/.codex/skills/<name>/SKILL.md`, or
`~/.claude/skills/<name>/SKILL.md` and follow it — usually that means running
`bash <skill-dir>/scripts/<entrypoint>.sh` with the documented flags.
Each SKILL.md is self-documenting; read it before invoking.
```

### Bootstrap a repo

Run once per target repo (from inside the repo):

```
/setup-red-skills
```

It walks you through five short decisions:

1. **Issue tracker.** GitHub Issues only — confirms `git remote -v` shows the right repo.
2. **Triage labels.** Maps the canonical state roles (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `blocked:dependency`, `wontfix`) to actual label strings.
3. **Domain docs.** Single-context (`.red/CONTEXT.md` + `.red/adr/`) or multi-context (`.red/CONTEXT-MAP.md` for monorepos).
4. **Workflows.** Installs `red-issues-needs-triage.yml` (auto-applies `needs-triage` so nothing slips past `/afk`).
5. **Token efficiency.** Strong recommendation to install [RTK](https://github.com/rtk-ai/rtk) before running `/afk` (details below).

Output: `.red/agents/*.md`, an `## Agent skills` block in `CLAUDE.md`/`AGENTS.md`, and `.github/workflows/red-*.yml`. All git-tracked. Re-run only to reconfigure from scratch.

---

## Memory — governed operational memory

Agents forget the exact things you need them to remember: why a decision was made, which workaround failed, what the last validation proved, and which warning is stale. The `memory` plugin turns that into a governed local memory surface.

The loop is deliberately boring:

```text
memory init
memory store "Decision: ..."
memory recall "what matters now"
memory claim-check "is this still true?"
memory readiness "should an agent start this?"
memory handoff "what should the next session know?"
```

Two modes ship today:

| Mode | What it gives you | Best for |
|------|-------------------|----------|
| `markdown-only` | Plain notes in `.red/memory/notes/` with explicit store/recall. No RedDB engine, no hooks, no background process. | Cautious rollout in any repo. |
| `graph` | Project-local `.red/memory/graph.rdb` with provenance, supersession, claim checks, readiness, context packs, hooks, MCP/HTTP, Workbench, and export. | Serious agent workflows where memory has to be trusted, inspected, and handed off. |

The useful path is Init -> Store -> Recall -> Verify -> Handoff. Everything else, vectors, docs search, Workbench panels, HTTP endpoints, and reference evals, exists to support that path instead of becoming another source of truth.

Start here: [plugins/memory/README.md](./plugins/memory/README.md).

---

## 🔁 The pipeline that feeds it

`/afk` is the last mile. The skills compose into the full loop:

```
  vague idea                       bug you hit                      something on fire
       │                                │                                  │
       │   /start                       │   /report-bug                    │   /urgent
       ▼                                ▼                                  ▼
   refined plan                  type:bug + needs-triage           priority:urgent +
       │                                │                          ready-for-agent
       │   /to-prd                      │   /triage                          │
       ▼                                ▼                                    │
   published PRD                  ready-for-agent  ◄──────────────── jumps queue
       │                                │                            (next /afk picks it
       │   /to-issues <PRD>             │                             first, ahead of
       ▼                                │                             --prd / --issues)
   children issues                      │
       │                                │
       │   /triage  (per child)         │
       ▼                                │
   ready-for-agent ─────────────────────┘
       │
       │   /afk                    Drain. Inner agent implements, tests pass,
       ▼                            merged, closed. Next iteration re-fetches
   shipped                          queue — `priority:urgent` always wins.
```

**Enter at any step.**
- Spec already written? Jump to `/to-issues`.
- Issues already triaged? Jump straight to `/afk`.
- Single feature, not a whole PRD? `/start` → `/to-issues` → `/afk` works fine.
- Bug report? `/report-bug` interviews you, files `type:bug + needs-triage`, then `/triage` writes the AGENT-BRIEF.
- Something on fire? `/urgent` skips triage entirely — `priority:urgent + ready-for-agent` direct, and `/afk` prepends urgents to its queue on every iteration so the next claim is yours.

The full issue lifecycle (`needs-triage` → `ready-for-agent` → `running` → `closed`, with `ready-for-human` and `needs-info` as branches) — including the ASCII state machine, the heartbeat protocol, and every label transition — lives in [`setup-red-skills/triage-labels.md`](./plugins/dev/skills/engineering/setup-red-skills/triage-labels.md).

### Nothing leaks

`/setup-red-skills` installs `red-issues-needs-triage.yml`, a GitHub Action that auto-applies `needs-triage` to every fresh issue with no labels. `/afk`'s startup straggler check warns you when unlabelled, `needs-triage`, or `needs-info` issues pile up. Belt **and** braces — the pipeline is hard to leak.

---

## 🗺 Codebase understanding surface

`/zoom-out` is the first Codebase understanding surface in the `dev` plugin. It is map-first: answers start with modules/layers, then relationships, critical paths, and risks/gaps, so you get orientation before raw detail.

When the optional `memory` plugin is initialized in Memory Graph mode and the graph has indexed content, `/zoom-out` is graph-aware. It may read graph neighbors and paths through the `dev` Memory bridge, interpret them into the map, and verify the explanation against current files. If Memory is absent, uninitialized, markdown-only, stale, empty, or failing, `/zoom-out` degrades to ordinary codebase exploration and still answers from the repo.

`/zoom-out` is read-only. It does not run `/memory:ingest`, reindex files, or write graph state. If graph indexing is absent or stale enough to matter, the answer can recommend that you explicitly run `/memory:ingest <path>` before a later zoom-out.

Boundaries:

| Surface | Use it for |
|---------|------------|
| `/zoom-out` | Map-first orientation over unfamiliar code; graph-aware when Memory Graph mode is ready. |
| `/memory:recall` | Search stored Memory notes or graph memory for relevant prior facts. |
| `/wiki query` | Ask over the private `.red/wiki/` knowledge cache and optionally save a synthesis page. |
| Future Ask surface | Direct question-first answers over project knowledge. This remains out of scope here. |

---

## 📚 Knowledge — your private LLM Wiki

```
$ /wiki ingest https://example.com/important-paper.pdf
[wiki] fetched → .red/wiki/raw/important-paper.md
[wiki] discussing key takeaways before writing pages…
[wiki] touched: pages/important-paper.md, pages/vannevar-bush.md, pages/associative-trails.md
[wiki] index.md and log.md updated.
```

Inspired by Karpathy's [LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f). Instead of RAG re-deriving knowledge on every query, the agent **maintains** an incremental markdown wiki at `.red/wiki/` (gitignored — your private knowledge cache, never leaves the machine).

- **[`/wiki-init`](./plugins/dev/skills/knowledge/wiki-init/SKILL.md)** — one-time bootstrap. Three questions (domain, source types, solo vs team) and you have a schema, layout, and `## Agent skills` registration.
- **[`/wiki`](./plugins/dev/skills/knowledge/wiki/SKILL.md)** routes by verb:

| Verb | What it does |
|------|--------------|
| `ingest <url\|path>` | Fetches the source, writes a source page, updates entity/concept pages, surfaces contradictions |
| `query <question>` | Searches index + pages, synthesises (prose, table, Mermaid), optionally files the answer back as a `synthesis` page |
| `lint` | Health check: contradictions, stale pages, orphans, stubs, missing concepts, open gaps |

Pages are typed (`entity`, `concept`, `source`, `synthesis`) with YAML frontmatter, standard markdown links (no Obsidian wikilinks — GitHub-portable), and an append-only `log.md` so every operation is auditable.

→ Walkthroughs: [research wiki](./plugins/dev/skills/knowledge/wiki-init/examples/research.md) · [book-reading wiki](./plugins/dev/skills/knowledge/wiki-init/examples/book-reading.md)

---


## Philosophy

Small, sharp skills. They work with any model. Each one targets a specific failure mode of code agents:

| Failure mode | Use |
|--------------|-----|
| Agent didn't do what I want | [`/reflect`](./plugins/dev/skills/productivity/reflect/SKILL.md), [`/start`](./plugins/dev/skills/engineering/start/SKILL.md) |
| Agent is verbose, no shared vocabulary | `.red/CONTEXT.md` + [`/start`](./plugins/dev/skills/engineering/start/SKILL.md) |
| Code doesn't work | [`/tdd`](./plugins/dev/skills/engineering/tdd/SKILL.md), [`/diagnose`](./plugins/dev/skills/engineering/diagnose/SKILL.md) |
| Codebase turned into a mud ball | [`/to-prd`](./plugins/dev/skills/engineering/to-prd/SKILL.md), [`/zoom-out`](./plugins/dev/skills/engineering/zoom-out/SKILL.md), [`/improve-codebase-architecture`](./plugins/dev/skills/engineering/improve-codebase-architecture/SKILL.md) |
| I want it to run while I sleep | [`/afk`](./plugins/dev/skills/engineering/afk/SKILL.md) |

Composable. Boring on purpose where boring is enough. Sharp where it matters.

---

## Reference

<details>
<summary><strong>Engineering — daily code work</strong></summary>

| Skill | What it does |
|-------|--------------|
| **[afk](./plugins/dev/skills/engineering/afk/SKILL.md)** | Drains `ready-for-agent` issues in isolated worktrees. Claude/Codex runner cascade, fleet mode (`/afk fleet N`), pluggable detectors via `.red/config.yaml`, canonical attempt envelopes on the issue thread, 48h sparkline monitor, statusline integration. |
| **[curate](./plugins/dev/skills/engineering/curate/SKILL.md)** | Interactive, archive-only Skill curator. Lists `archive` candidates from `memory curate skills --json`, requires explicit approval, performs a recoverable archive of Curatable skills (atomic `rename` + SHA-256 manifest), and reverses it with `/curate --restore <name>`. Tracer slice — only the `archive` category is wired. |
| **[context](./plugins/dev/skills/engineering/context/SKILL.md)** | Compose the RedSkills context stack before non-trivial work: domain docs, ADRs, LLM Wiki, Memory graph/recall, graph-aware zoom-out, durable learning capture, and self-improvement telemetry. |
| **[diagnose](./plugins/dev/skills/engineering/diagnose/SKILL.md)** | Disciplined diagnosis: reproduce → minimise → hypothesise → instrument → fix → regression-test. |
| **[start](./plugins/dev/skills/engineering/start/SKILL.md)** | Grilling session that challenges your plan against the domain model; updates `.red/CONTEXT.md` and ADRs inline. |
| **[hitl](./plugins/dev/skills/engineering/hitl/SKILL.md)** | Resolves one `ready-for-human` issue by extracting the pending decision, recording Human guidance, and promoting it back to `ready-for-agent` when delegable. |
| **[triage](./plugins/dev/skills/engineering/triage/SKILL.md)** | Moves issues through the triage state machine; writes the AGENT-BRIEF that `/afk` will consume. |
| **[report-bug](./plugins/dev/skills/engineering/report-bug/SKILL.md)** | Interview the user about a bug, then file a `type:bug needs-triage` issue on the tracker. Seeds from conversation context when invoked with no argument. |
| **[urgent](./plugins/dev/skills/engineering/urgent/SKILL.md)** | File a `priority:urgent` issue that bypasses `/triage` and jumps the head of the `/afk` queue, ahead of any `--prd N` / `--issues a,b,c` filter. Use when something is on fire. |
| **[improve-codebase-architecture](./plugins/dev/skills/engineering/improve-codebase-architecture/SKILL.md)** | Finds deepening opportunities in the codebase, informed by `.red/CONTEXT.md` and `.red/adr/`. |
| **[tdd](./plugins/dev/skills/engineering/tdd/SKILL.md)** | Red-green-refactor loop; one vertical slice at a time. |
| **[to-issues](./plugins/dev/skills/engineering/to-issues/SKILL.md)** | Breaks a plan, spec, or PRD into independently-grabbable issues via vertical slices. |
| **[to-prd](./plugins/dev/skills/engineering/to-prd/SKILL.md)** | Turns the current conversation into a PRD; publishes as a GitHub issue. |
| **[zoom-out](./plugins/dev/skills/engineering/zoom-out/SKILL.md)** | Map-first Codebase understanding; graph-aware when Memory Graph mode is ready, read-only when it is not. |
| **[prototype](./plugins/dev/skills/engineering/prototype/SKILL.md)** | Throwaway prototype — terminal app for state/logic, or UI variations toggleable from one route. |
| **[setup-red-skills](./plugins/dev/skills/engineering/setup-red-skills/SKILL.md)** | Per-repo config: issue tracker, triage label vocab, domain doc layout, RedSkills workflows, RTK. |
| **[statusline](./plugins/dev/skills/engineering/statusline/SKILL.md)** | Installs or inspects the RedSkills Claude Code statusline, rendering the live AFK block via `node bin/afk.mjs statusline`. |

</details>

<details>
<summary><strong>Knowledge — incremental wiki</strong></summary>

| Skill | What it does |
|-------|--------------|
| **[wiki-init](./plugins/dev/skills/knowledge/wiki-init/SKILL.md)** | Bootstrap `.red/wiki/`, write the schema, gitignore artefacts, register under `## Agent skills`. |
| **[wiki](./plugins/dev/skills/knowledge/wiki/SKILL.md)** | `ingest` / `query` / `lint` — operate on the wiki. |

</details>

<details>
<summary><strong>Productivity — workflow</strong></summary>

| Skill | What it does |
|-------|--------------|
| **[reflect](./plugins/dev/skills/productivity/reflect/SKILL.md)** | Interviews you until every branch of the decision tree is resolved. |
| **[handoff](./plugins/dev/skills/productivity/handoff/SKILL.md)** | Compacts the current conversation into a handoff doc for the next agent. |
| **[write-a-skill](./plugins/dev/skills/productivity/write-a-skill/SKILL.md)** | Scaffolds new skills with proper structure and progressive disclosure. |

</details>

<details>
<summary><strong>Misc — niche utilities</strong></summary>

| Skill | What it does |
|-------|--------------|
| **[branch-lock](./plugins/dev/skills/misc/branch-lock/SKILL.md)** | Locks the agent to a branch and blocks it from switching away (agent-only pre-tool hook for Claude Code and Codex). |
| **[git-guardrails-claude-code](./plugins/dev/skills/misc/git-guardrails-claude-code/SKILL.md)** | Claude Code hooks that block destructive git commands. |
| **[migrate-to-shoehorn](./plugins/dev/skills/misc/migrate-to-shoehorn/SKILL.md)** | Migrates test files from `as` type assertions to `@total-typescript/shoehorn`. |
| **[scaffold-exercises](./plugins/dev/skills/misc/scaffold-exercises/SKILL.md)** | Creates exercise scaffolds with sections, problems, solutions. |
| **[setup-pre-commit](./plugins/dev/skills/misc/setup-pre-commit/SKILL.md)** | Configures Husky pre-commit with lint-staged, Prettier, type-check, tests. |

</details>

<details>
<summary><strong>Memory plugin — persistent memory (markdown-only · graph)</strong></summary>

The separate **`memory`** plugin gives agents governed operational memory:
scoped decisions, gotchas, provenance, supersession, and trust checks that
survive `/clear` and cross sessions. It lives on top of `dev` (requires it).
Two storage modes ship today: **markdown-only** (plain notes, zero engine
dependency) and **graph** (a governed evidence graph over a per-project RedDB
store). Graph mode can opt into lifecycle hooks, Skill telemetry, MCP/HTTP
access, Workbench diagnostics, and graph export; markdown-only remains
explicit-only with no engine. Install `memory` alongside `dev`, then use the
[Memory golden path](./plugins/memory/README.md#golden-path-governed-operational-memory).

The detailed Memory README also carries the reference comparison and the
claim-to-eval evidence map used by `references:eval:v2`, so public claims stay
tied to executable checks instead of unsupported marketing copy.

| Skill | What it does |
|-------|--------------|
| **[init](./plugins/memory/skills/core/init/SKILL.md)** | Setup wizard. markdown-only writes `.red/memory/config.json` + `.red/memory/notes/`; graph also builds locally and provisions a per-project RedDB store at `.red/memory/graph.rdb`. Hooks off, MCP off. |
| **[store](./plugins/memory/skills/core/store/SKILL.md)** | `/memory:store <fact>` — save a fact (markdown note, or a deduped graph node). |
| **[recall](./plugins/memory/skills/core/recall/SKILL.md)** | `/memory:recall <query>` — ranked search over stored memory (notes, or the graph with supersede-aware, neighborhood-expanded results). |
| **[ingest](./plugins/memory/skills/core/ingest/SKILL.md)** | `/memory:ingest <path>` — walk a repo into the graph: code symbols + markdown structure with their edges (graph mode). |
| **[extract](./plugins/memory/skills/core/extract/SKILL.md)** | `/memory:extract <transcript>` — extract durable `INFERRED` facts from a transcript using the configured provider (graph mode). |
| **[skills-status](./plugins/memory/skills/core/skills-status/SKILL.md)** | `/memory:skills-status` — diagnose Skill telemetry and recent usage before curation/self-improvement. |
| **[improve-skills](./plugins/memory/skills/core/improve-skills/SKILL.md)** | `/memory:improve-skills` — generate approval-gated Skill improvement proposals from telemetry and apply reviewed structured patches only with explicit `--yes`. |
| **[health](./plugins/memory/skills/core/health/SKILL.md)** | `/memory:health` — report operational Memory health: graph readiness, freshness, telemetry rollups, ranked candidates, pending proposals, and next actions. |
| **[context-status](./plugins/memory/skills/core/context-status/SKILL.md)** | `/memory:context-status` — report context stack readiness across agent rules, domain docs, ADRs, Memory graph/freshness/telemetry, Wiki, score, and recommendations. |
| **[doctor](./plugins/memory/skills/core/doctor/SKILL.md)** | `/memory:doctor` — flag stale nodes (long-unaccessed, never recalled) and prune them after confirmation (graph mode). |
| **[export](./plugins/memory/skills/core/export/SKILL.md)** | `/memory:export` — export the graph to a navigable graph.html + graph.json + audit.md (graph mode). |

See [plugins/memory/README.md](./plugins/memory/README.md) and, for the RedDB
graph-write constraints, [ADR 0007](./.red/adr/0007-reddb-graph-writes-via-multi-model-dml.md).
Graph mode provides the governed recall, lifecycle hooks, MCP/HTTP surfaces,
Skill telemetry, and soft integrations used by `dev`.

</details>

<details>
<summary><strong>MCP servers — bundled tools</strong></summary>

| Server | What it does |
|--------|--------------|
| **[code-nav](./src/apps/code-nav/README.md)** | LSP-backed semantic navigation. Spawns the language server for each file type and exposes `workspace_symbols`, `goto_definition`, `find_references`, `document_symbols`, `hover` as MCP tools — IDE-grade symbol navigation on top of the agent's default search. Presets for TS/Go/Rust/Python; extend via `CODE_NAV_SERVERS`. Loads automatically with the `dev` plugin. |

</details>

---

## House conventions

- 🏷 **Labels are kebab-case or `prefix:value`.** `needs-triage`, `ready-for-agent`, `running`, `priority:high`, `prd:42`. No uppercase, no spaces.
- 🤖 **Workflows shipped by RedSkills start with `red-`.** `red-issues-needs-triage.yml`, `red-upstream-watch.yml`.
- 🐙 **Issues and PRDs live on GitHub.** No local-markdown tracker, no GitLab/Jira/Linear fallback.
- 📁 **Artefacts live under `.red/`.** Context glossary, ADRs, agent docs, the wiki, the `/afk` state file. Keeps consumer repos clean.
- 🔒 **SSH for git, every time.** No HTTPS remotes. `/afk` refuses to start otherwise.

---

## License

Apache-2.0. See [LICENSE](./LICENSE). The [NOTICE](./NOTICE) file preserves the original MIT attribution for upstream-derived skills from [`mattpocock/skills`](https://github.com/mattpocock/skills).
