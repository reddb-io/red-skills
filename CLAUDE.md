# RedSkills — Agent Instructions

Public reddb.io repository containing the engineering skills (slash commands) used with Claude Code, Codex, Gemini CLI, and similar agents.

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
│   └── code-nav/                   ← code navigation runtime implementation
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
`plugins/` with their own `.claude-plugin/plugin.json`,
`.codex-plugin/plugin.json`, and their own `skills/` tree. Each plugin appears
as a separate entry in both marketplace manifests, and any runtime code for it
lives under `apps/<plugin>/`.

`personal/` and `deprecated/` were removed from upstream and **must not be recreated**.

## Rules

1. Every skill in `engineering/`, `knowledge/`, `productivity/`, or `misc/` must be listed in the root `README.md` **and** in the owning plugin's `.claude-plugin/plugin.json` (e.g. `plugins/dev/.claude-plugin/plugin.json`). The owning plugin's `.codex-plugin/plugin.json` must expose the same `skills/` tree. Skills in `in-progress/` appear in neither.
2. Each entry in `README.md` links the skill name to its `SKILL.md`.
3. Each bucket has its own `README.md` listing the bucket's skills with a one-line description.
4. `LICENSE` is Apache-2.0. The `NOTICE` file preserves Matt Pocock's original MIT copyright for the upstream-derived skills under `plugins/dev/skills/` — **do not remove or alter that attribution**. See ADR 0004.
5. Glossary docs use the ADR 0021 multi-context model: `.red/CONTEXT.md` is only
   a compatibility pointer to `.red/CONTEXT-MAP.md`; live glossary terms belong
   in `.red/contexts/{dev,memory,brain}/CONTEXT.md`, in the context that owns
   the term.
6. **All repo content is in English.** No Portuguese (or any other language) in committed files — SKILL.md, README, CHANGES, ADRs, comments, frontmatter descriptions. Chat with the user can stay Portuguese; the repo cannot.

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
