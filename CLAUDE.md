# RedSkills — Agent Instructions

Public reddb.io repository containing the engineering skills (slash commands) used with Claude Code, Codex, OpenCode, Gemini CLI, and similar agents.

## Origin

Adapted from [`mattpocock/skills`](https://github.com/mattpocock/skills) (MIT). Not a git fork — we copied the structure so we can diverge freely. The upstream SHA we based on is in `.upstream`. The `.github/workflows/red-upstream-watch.yml` workflow opens an issue when upstream advances.

## Structure

The repo is a Claude Code **plugin marketplace** that hosts shipped plugin
definitions plus a top-level TypeScript implementation workspace. Layout:

```
red-skills/                         ← repo root + marketplace
├── .claude-plugin/
│   └── marketplace.json            ← marketplace manifest, lists every plugin
├── .agents/
│   └── plugins/marketplace.json    ← Codex marketplace manifest
├── .red/
│   ├── CONTEXT.md                  ← compatibility pointer; start at CONTEXT-MAP.md
│   ├── CONTEXT-MAP.md              ← multi-context glossary entry point
│   └── contexts/
│       ├── dev/CONTEXT.md          ← `dev` plugin glossary
│       ├── memory/CONTEXT.md       ← `memory` plugin glossary
│       └── brain/CONTEXT.md        ← `brain` plugin glossary
├── apps/                           ← runtime implementations (ADR 0034, relocated to root by ADR 0060)
│   ├── dev/                        ← `dev` runtime implementation
│   ├── memory/                     ← `memory` runtime implementation
│   ├── brain/                      ← `brain` runtime implementation
│   ├── code-nav/                   ← code navigation runtime implementation
│   └── opencode-host/              ← opencode-host adapter: emits opencode.json from .red/config.yaml (ADR 0075; Slice 1 = provider block)
├── packages/                       ← code shared by multiple runtimes
│   ├── shared/                     ← CLI args, bundle-fetch, entrypoint (ADR 0034)
│   ├── build-info/                 ← shared build metadata helpers
│   └── red-castle/                 ← git submodule: AFK execution substrate (@reddb-io/red-castle, ADR 0061)
├── dist/                           ← generated release bundles and manifests
└── plugins/
    ├── dev/                        ← shipped `dev` plugin definition
    │   ├── .claude-plugin/plugin.json
    │   ├── .codex-plugin/plugin.json
    │   └── skills/
    │       ├── engineering/        ← day-to-day code work
    │       ├── knowledge/          ← knowledge accumulation and curation (LLM Wiki pattern)
    │       ├── productivity/       ← general workflow, not code-specific
    │       ├── misc/               ← kept but rarely used
    │       └── in-progress/        ← drafts, do not publish yet
    ├── memory/                     ← shipped `memory` plugin definition
    └── brain/                      ← shipped `brain` plugin definition
```

`plugins/` is the agent-facing definition surface: manifests, skills, hooks, and
docs. Runtime implementation lives in root-level `apps/`, shared code in
`packages/`, and generated bundles belong under `dist/` when bundle/release
builds run. ADR 0034 introduced the definitions/implementation split as
implementation domains plus a shared layer; ADR 0060 relocated that split to the
conventional Turborepo layout — `apps/<plugin>/` and `packages/shared/` at the
repo root — with shared dependency versions consolidated into a pnpm `catalog:`.

Future plugins (e.g. `data`, `ops`) live as additional siblings under
`plugins/` with their own `.claude-plugin/plugin.json`, generated
`.codex-plugin/plugin.json`, and their own `skills/` tree. Each plugin appears
as a separate entry in the Claude marketplace manifest; the Codex marketplace
manifest is generated from it. Any runtime code for a plugin lives under
`apps/<plugin>/`.

`personal/` and `deprecated/` were removed from upstream and **must not be recreated**.

## Rules

1. Every skill in `engineering/`, `knowledge/`, `productivity/`, or `misc/` must be listed in the root `README.md` **and** in the owning plugin's `.claude-plugin/plugin.json` (e.g. `plugins/dev/.claude-plugin/plugin.json`). Skills in `in-progress/` appear in neither.
2. Codex manifests are generated artifacts. Do not hand-edit `.agents/plugins/marketplace.json` or `plugins/*/.codex-plugin/plugin.json`; change the Claude-side manifests or plugin tree, then run `pnpm codex:manifests`.
3. Each entry in `README.md` links the skill name to its `SKILL.md`.
4. Each bucket has its own `README.md` listing the bucket's skills with a one-line description.
5. `LICENSE` is Apache-2.0. The `NOTICE` file preserves Matt Pocock's original MIT copyright for the upstream-derived skills under `plugins/dev/skills/` — **do not remove or alter that attribution**. See ADR 0004.
6. Glossary docs use the ADR 0021 multi-context model: `.red/CONTEXT.md` is only
   a compatibility pointer to `.red/CONTEXT-MAP.md`; live glossary terms belong
   in `.red/contexts/{dev,memory,brain}/CONTEXT.md`, in the context that owns
   the term.
7. **All repo content is in English.** No Portuguese (or any other language) in committed files — SKILL.md, README, CHANGES, ADRs, comments, frontmatter descriptions. Chat with the user can stay Portuguese; the repo cannot.
8. **ask-red maintenance rule.** any skill add, rename, removal, or flow change must re-check `plugins/dev/skills/engineering/ask-red/SKILL.md`, update its Coverage Inventory and routes, and keep the `/doctor` router sync check green.

## Plugin activation (ADR 0067)

RedSkills plugins (`dev`, `memory`, `brain`) install their hooks **globally** on
every agent, but a plugin only runs in a directory whose `.red/config.yaml` sets
`plugins.<name>.enabled: true` (strict opt-in). No `.red/config.yaml`, or a block
without the explicit `enabled: true`, → the plugin stays fully inert there (no
bundle fetch, no hooks). `/setup-red-skills` is the **only** thing authorized to
create `.red/` and to write the activation flags — no other code path may create
`.red/`. The gate lives in `packages/shared/plugin-gate.ts` (consumed by the dev
launchers) with a mirrored inline copy in each of memory/brain's `bootstrap.mjs`;
keep the three in lockstep.

## Token-efficient terminal work

RTK is the preferred compression layer for noisy development commands in this repo. If `rtk --version` succeeds, prefer RTK-wrapped commands when summarized output is enough:

- `rtk git status`, `rtk git diff`, `rtk gh ...`
- `rtk vitest ...`, `rtk tsc ...`, `rtk pnpm ...`
- `rtk test <cmd>`, `rtk err <cmd>`, `rtk summary <cmd>` for broad or noisy runs

Use raw commands instead when exact stdout/stderr is part of the behavior under test, when an RTK filter hides evidence needed for debugging, or when applying low-level git conflict resolution where full output matters. If a Claude/Codex hook is available, let the hook rewrite routine commands; otherwise call `rtk` explicitly.

## Change report vs upstream

**Whenever you modify, add, or remove a skill that came from `mattpocock/skills`, record it in `CHANGES.md`**.

Format:

```markdown
## <skill-name> (<bucket>)

- **status**: modified | added | removed | renamed-from-<original>
- **upstream**: `<short SHA if applicable>`
- **why**: <one-line reason>
- **what changed**: <short bullets>
```

When bumping the SHA in `.upstream`, review `CHANGES.md`, close the matching `upstream-drift` issue, and update recorded SHAs if we cherry-picked anything.

## Creating a new (non-Matt) skill

Use `/write-a-skill`. Mark it in `CHANGES.md` as `status: added` with `upstream: —` to make clear it's original to reddb.io.

## SKILL.md body convention

RedSkills `SKILL.md` files use two XML-style sections to separate **what the agent must do** from **reference material**. When you invoke any RedSkills skill, treat the sections like this:

- **`<what-to-do>`** — the **primary directive**. Imperative, non-negotiable. Execute the loop / steps / rules inside it literally. Do not paraphrase, do not skip steps, do not substitute "what feels right" for the explicit rules. If the section contains DOs / DON'Ts (✅ / ❌), they are hard constraints.
- **`<supporting-info>`** — **reference material, consulted on demand**. Formats, file layouts, trigger conditions, examples. Read these *when the primary directive points you here*, not as additional tasks to complete in parallel.

If a skill has only one of the two sections, the whole body is the primary directive. Skills without either tag are short enough that the entire body is the directive.

Never reorder priorities so that documentation/side-effect work in `<supporting-info>` competes with the interview / implementation / review loop defined in `<what-to-do>`.

### SKILL.md writing style (sentence-level)

The body convention above is **section-level** — it decides *where* a sentence goes. Underneath it sits the **sentence-level** writing convention: nine techniques (bold lead-in + gloss; maxim/slogan compression; prohibition + reason inline; literal phrasing in quotes; vocabulary hygiene; numbered taxonomy; self-demonstrating voice; precondition-carrying headers; leading words) that decide *how each sentence reads*. It is **additive — it complements the `<what-to-do>`/`<supporting-info>` split, it does not replace it.** When writing or editing any RedSkills SKILL.md, apply both. The full list with before → after examples lives in `plugins/dev/skills/productivity/write-a-skill/WRITING-STYLE.md`.

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

**`/afk` is the modus operandi; `/go` is the ad-hoc exception.**

- **Maximize autonomous `/afk` drainage — that is the mission.** `/afk` is the default lane for **all work that is or should be a tracked issue**. The healthy steady state: every open executable issue is either `ready-for-agent` or gated for a *real, still-pending* reason. `ready-for-agent: 0` with a non-empty backlog is a **flow bug to diagnose, never a clean stop**: census the gates (`blocked:dependency` — verify each `req:*` target actually still pends, a delivered-but-open Spec strands its dependents; `needs-triage` stragglers; `ready-for-human` parks; `type:spec`) and clear the highest-leverage one. Humans enter the loop only for genuine decisions and broken flows.
- One-off concrete work goes through `/go "<demand>"` (ADR 0081): it mints a disposable `lane:go` issue, works in an isolated worktree under `.red/tmp/go-workers/`, runs the shared gate, and brings back a PR. **`/go` is only for genuinely untracked, ad-hoc, one-off demands** — never a fallback for issue-form work, never a menu option for tracked backlog. "It's already an issue" or "it should be one" means `/afk` owns it, not `/go`. A tracked backlog issue belongs to `/afk` because routing tracked work through `/go` drains the autonomous lane into human-babysat dispatches. Put a parked issue back in the queue with `/requeue`.
- When working by hand instead (e.g. a slice the maintainer decided to land manually), work in an isolated worktree under `.red/tmp/work-*/`; do not create sibling worktrees outside the repo.
- Create task branches with `git worktree add .red/tmp/work-<slug> -b <branch> origin/main`, not with `git checkout -b` or `git switch -c` in the primary checkout.
- Commit the worktree, push the branch early, open a PR, monitor its checks, then merge it or park the issue/PR for `/hitl`.
- The agent never switches the primary checkout's branch; only the user does. With `plugins.dev.enabled: true`, the dev command proxy blocks agent-created worktrees outside `.red/tmp/` and primary-checkout branch movement.
