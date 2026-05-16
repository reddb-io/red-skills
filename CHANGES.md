# CHANGES — Divergences from upstream

Records every change made to skills inherited from [`mattpocock/skills`](https://github.com/mattpocock/skills), plus new skills created by reddb.io. See the rules in [CLAUDE.md](./CLAUDE.md).

Upstream base: `mattpocock/skills@e74f0061bb67222181640effa98c675bdb2fdaa7` (see `.upstream`).

---

## setup-red-skills + README: RTK as recommended companion

- **status**: modified
- **upstream**: —
- **why**: long `/afk` runs (and engineering work generally) burn a large fraction of tokens on noisy CLI output — `pnpm install` progress, verbose `git status`, `gh` JSON. [RTK](https://github.com/rtk-ai/rtk) is a transparent hook-layer CLI proxy that saves 60–90% on routine dev ops with zero changes to skill code. Strong recommendation, not a hard dependency.
- **what changed**:
  - `setup-red-skills/SKILL.md`: new Section E — Token efficiency, with install command, verification steps, and the `rtk-ai/rtk` vs `reachingforthejack/rtk` name-collision warning
  - `README.md`: new "Before a long /afk run — install RTK" callout under Setup, with install one-liner and the same name-collision warning
  - skill overview list now mentions "Token efficiency" as a setup dimension

## caveman (productivity)

- **status**: removed
- **upstream**: `e74f006`
- **why**: maintainer preference — caveman mode adds noise to the maintainer's chat; the user prefers full sentences. The skill is available globally via the `caveman` plugin if anyone wants it.
- **what changed**:
  - removed `skills/productivity/caveman/`
  - de-registered from `.claude-plugin/plugin.json`, root `README.md` reference table, `skills/productivity/README.md`

## global: repo content fully translated to English

- **status**: modified (cross-cutting policy)
- **upstream**: —
- **why**: reddb.io policy — 100% of committed repo content (SKILL.md files, READMEs, CHANGES.md, CLAUDE.md, ADRs, templates, examples, workflow comments) must be in English. Keeps the skill library shareable, contributor-friendly, and consistent with upstream. User chat may stay Portuguese — the repo cannot.
- **what changed**:
  - translated to English: `CLAUDE.md`, `README.md` (root), `CHANGES.md`, `.red/CONTEXT.md`, `skills/engineering/setup-red-skills/SKILL.md` Section A explainer, all of `skills/knowledge/` (`README.md`, `wiki-init/SKILL.md`, `wiki-init/schema-template.md`, `wiki-init/index-template.md`, the four `page-template-*.md`, the two `examples/*.md`, `wiki/SKILL.md`, `wiki/REFERENCES.md`)
  - English-only rule documented in `CLAUDE.md` rules list

## global: workflow filenames prefixed `red-`

- **status**: modified
- **upstream**: —
- **why**: clear namespace for workflows shipped or owned by RedSkills, separating them from a host project's own CI workflows
- **what changed**:
  - `.github/workflows/upstream-watch.yml` → `red-upstream-watch.yml` (and `name:` field updated)
  - convention enforced going forward — see `feedback_red_workflow_prefix` memory and `setup-red-skills/workflows/` templates

## global: label naming convention (kebab-case or `prefix:value`)

- **status**: modified
- **upstream**: —
- **why**: consistent vocab makes labels easy to scan in the UI, easy to grep, and easy to filter with `gh issue list --label`. No uppercase/Camel/snake/space-separated labels.
- **what changed**:
  - `triage-labels.md` auxiliary labels: `prd-{N}` → `prd:{N}`, `HITL` → `slice:hitl`, `AFK` → `slice:afk`
  - `afk/scripts/afk.sh` PRD filter updated to match `prd:N`
  - naming convention section added to `setup-red-skills/triage-labels.md`

## setup-red-skills (engineering) — renamed from setup-redskills

- **status**: renamed-from-setup-redskills
- **upstream**: — (second internal rename; the original was `setup-matt-pocock-skills`)
- **why**: consistency with the rest of the vocab — RedSkills is logically two words (`red-` is the namespace prefix); skill, plugin, and workflows now share the same pattern (`red-skills`, `red-issues-needs-triage`, etc.)
- **what changed**:
  - directory `skills/engineering/setup-redskills` → `setup-red-skills`
  - frontmatter `name: setup-redskills` → `setup-red-skills`
  - live refs in `plugin.json`, `engineering/README.md`, `.red/CONTEXT.md`, `.red/adr/0001-*.md`, `to-prd/SKILL.md`, `to-issues/SKILL.md`, `triage/SKILL.md`, `afk/SKILL.md`, `in-progress/review/SKILL.md`, `wiki-init/SKILL.md`
  - historical entries in `CHANGES.md` preserved with the old name (they document the past)

## setup-red-skills: workflows shipped to consumer repos (auto-triage)

- **status**: modified
- **upstream**: `e74f006`
- **why**: close the "lost issue" gap — issues created outside the `/to-issues` flow arrive unlabelled and stay invisible to `/triage` and `/afk` (which filters on `ready-for-agent`). The workflow auto-applies `needs-triage` to every `opened`/`reopened` issue with no labels.
- **what changed**:
  - new `skills/engineering/setup-red-skills/workflows/red-issues-needs-triage.yml` (template installed into `.github/workflows/` of the consumer repo)
  - `setup-red-skills/SKILL.md`: new Section D — Workflows; step 4 copies `workflows/red-*.yml` into `.github/workflows/`; creates the `needs-triage` label if missing
  - convention: all workflows shipped by RedSkills use the `red-` filename prefix (clear namespace vs the consumer project's own CI)

## setup-red-skills: canonical lifecycle + priorities high/low

- **status**: modified
- **upstream**: `e74f006`
- **why**: `setup-red-skills/triage-labels.md` is the single source of truth for the label vocab — added a full lifecycle (ASCII state machine), the `running` label (consumed only by `/afk`), the heartbeat protocol, and auxiliary labels (`bug`, `enhancement`, `priority:high|low`, `prd:N`, `slice:hitl`, `slice:afk`). `/afk` SKILL.md references the canonical doc and only shows its own slice. Priorities reduced to two (`high`/`low`) — less hesitation in triage.
- **what changed**:
  - `setup-red-skills/triage-labels.md`: rewritten with mapping table + ASCII state machine + state definitions + heartbeat protocol + auxiliary labels + naming convention note
  - `afk/SKILL.md`: new section "Issue Lifecycle (the `/afk` slice)" with a focused diagram; references the canonical doc
  - `afk/scripts/afk.sh`: `cleanup()` on SIGINT/SIGTERM now releases the claim (`running` → `ready-for-agent`) and posts a comment; issue sort simplified to `priority:high` before the rest; PRD filter now looks for `prd:N` label instead of `prd-N`

## afk (engineering, new skill, original to reddb.io)

- **status**: added
- **upstream**: —
- **why**: we needed a single autonomous entry point that: (1) integrates with GitHub Issues (label `ready-for-agent`), (2) runs in isolated worktrees so it never touches the primary checkout, (3) coordinates state via labels + comments + heartbeat, (4) alternates runners (claude/codex) on rate-limit, (5) delivers responsive feedback (live header + monitor + state file).
- **what changed**:
  - new `skills/engineering/afk/` with `SKILL.md`, `AGENT-PROMPT.md`, `SAFETY.md`, `runner-claude.md`, `runner-codex.md`
  - `scripts/afk.sh` (main loop), `scripts/once.sh` (debug single iteration), `scripts/monitor.sh` (readonly state board)
  - filters: `--prd N`, `--issues N,N,N`, default = all `ready-for-agent`; flags `--runner`, `-n`, `--once`
  - drop file format follows the `handoff` style in `.red/tmp/drop-{N}-{slug}.md` (gitignored); references over duplication
  - atomic state file at `.red/tmp/afk-state.json`; monitor reads, orchestrator writes
  - heartbeat sub-shell `:one:` → `:four:` every 10 min via `gh issue comment`
  - merge-back with auto-snapshot when primary is dirty; conflict = `ready-for-human`, worktree preserved
  - runner exhaustion → automatic mid-issue swap; both exhausted → exit 75
  - straggler check at startup: warns about unlabelled / `needs-triage` / `needs-info` issues and (on a TTY) prompts before draining
  - registered in `plugin.json` and `README.md`

## knowledge/ (new bucket) + wiki-init + wiki (new skills, original to reddb.io)

- **status**: added
- **upstream**: — (not from Matt; Karpathy's [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) pattern)
- **why**: bring an incremental, LLM-maintained knowledge accumulation pattern into RedSkills, distinct from RAG and from the technical glossary (`.red/CONTEXT.md`)
- **what changed**:
  - new bucket `skills/knowledge/` with `README.md`
  - `skills/knowledge/wiki-init/` — bootstrap (SKILL.md, schema-template.md, index-template.md, 4 page templates, 2 examples under `examples/`)
  - `skills/knowledge/wiki/` — operations (SKILL.md, REFERENCES.md with Karpathy/Memex/Tolkien Gateway/qmd/Obsidian Dataview/Web Clipper/Zettelkasten)
  - policies: layout `.red/wiki/{raw,pages,index.md,log.md}` + schema at `.red/agents/wiki.md`; kebab-case names; frontmatter `title/type/tags/created/updated/sources`; `.red/wiki/` 100% gitignored; isolated from CONTEXT/ADR; search via index+grep with future migration to qmd
  - registered in `.claude-plugin/plugin.json`, root `README.md`, and `CLAUDE.md`

## reflect (productivity) — renamed from grill-me

- **status**: renamed-from-grill-me
- **upstream**: `e74f006`
- **why**: reddb.io vocab — "reflect" conveys intent without the aggressive tone of "grill"
- **what changed**:
  - directory `skills/productivity/grill-me` → `reflect`
  - `name:` frontmatter → `reflect`; description adjusted (trigger "reflect" instead of "grill me")
  - refs in `plugin.json`, `README.md`, `skills/productivity/README.md`, `skills/engineering/triage/SKILL.md`, `skills/engineering/improve-codebase-architecture/SKILL.md`, etc.

## start (engineering) — renamed from grill-with-docs

- **status**: renamed-from-grill-with-docs
- **upstream**: `e74f006`
- **why**: reddb.io vocab — this is the kickoff skill for any non-trivial work
- **what changed**:
  - directory `skills/engineering/grill-with-docs` → `start`
  - `name:` frontmatter → `start`
  - refs in `plugin.json`, `README.md`, `skills/engineering/README.md`, `improve-codebase-architecture/SKILL.md`, `triage/SKILL.md`, `setup-redskills/domain.md`, etc.
  - body rewrite (tags kept as `<what-to-do>` / `<supporting-info>`): frontloaded an explicit loop, hard DO/DON'T list, and a question-format template so the interview behaviour dominates over the documentation side-effects. CONTEXT/ADR rules demoted to "trigger" subsections instead of equal-weight tasks (model was drifting into docs mode instead of grilling).

## global: GitHub Issues as the only supported tracker

- **status**: modified (cross-cutting policy)
- **upstream**: `e74f006`
- **why**: reddb.io policy — issues and PRDs always on GitHub, never local; removes branching for local-markdown, GitLab, Jira, Linear
- **what changed**:
  - removed `skills/engineering/setup-redskills/issue-tracker-local.md` and `issue-tracker-gitlab.md`
  - `setup-redskills/SKILL.md` Section A rewritten: GitHub only, no "Local markdown" / "GitLab" / "Other"; explorer no longer looks for `.red/scratch/`
  - `setup-redskills` description and overview updated
  - `skills/in-progress/review/SKILL.md` step 2: removed refs to `GitLab !67` and `.red/scratch/`

## global: `.red/` namespace for artefacts in consumer repos

- **status**: modified (cross-cutting)
- **upstream**: `e74f006`
- **why**: keep client repos clean and identifiable — every artefact produced or consumed by RedSkills lives under `.red/` rather than polluting the root with `CONTEXT.md`, `docs/adr/`, `docs/agents/`, `.scratch/`
- **what changed**:
  - `CONTEXT.md` → `.red/CONTEXT.md`
  - `CONTEXT-MAP.md` → `.red/CONTEXT-MAP.md`
  - `docs/adr/` → `.red/adr/`
  - `docs/agents/` → `.red/agents/`
  - `.scratch/` → `.red/scratch/`
  - applied across every skill in `engineering/`, `in-progress/`, and the root files (`CLAUDE.md`, `README.md`, this repo's own `CONTEXT.md` and `docs/adr/`)

## setup-redskills (engineering)

- **status**: renamed-from-setup-matt-pocock-skills
- **upstream**: `e74f006`
- **why**: Matt's name doesn't fit a plugin called `redskills`
- **what changed**:
  - directory `skills/engineering/setup-matt-pocock-skills` → `setup-redskills`
  - heading `# Setup Matt Pocock's Skills` → `# Setup RedSkills`
  - references in `to-prd`, `to-issues`, `triage`, `review`, `engineering/README.md`, `docs/adr/0001-*.md` updated

## deprecated/ (bucket)

- **status**: removed
- **upstream**: `e74f006`
- **why**: reddb.io decision not to ship dead skills
- **what changed**: removed all of `skills/deprecated/` (ubiquitous-language, qa, design-an-interface, request-refactor-plan)

## personal/ (bucket)

- **status**: removed
- **upstream**: `e74f006`
- **why**: skills tied to Matt's personal setup, not applicable to reddb.io
- **what changed**: removed all of `skills/personal/` (edit-article, obsidian-vault)
