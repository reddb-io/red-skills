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
├── .gemini-plugin/
│   └── marketplace.json            ← Gemini CLI marketplace manifest
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
│   ├── redskilled/                 ← host-scoped execution daemon: exactly one singleton per machine behind a unix socket (ADR 0130)
│   └── opencode-host/              ← opencode-host adapter: emits opencode.json from .red/config.yaml (ADR 0075; Slice 1 = provider block)
├── packages/                       ← code shared by multiple runtimes
│   ├── shared/                     ← CLI args, bundle-fetch, entrypoint (ADR 0034)
│   ├── build-info/                 ← shared build metadata helpers
│   └── red-castle/                 ← vendored AFK execution substrate source (@reddb-io/red-castle, ADR 0061/0101)
├── dist/                           ← generated release bundles and manifests
└── plugins/
    ├── dev/                        ← shipped `dev` plugin definition
    │   ├── .claude-plugin/plugin.json
    │   ├── .codex-plugin/plugin.json
    │   ├── .gemini-plugin/plugin.json
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
`.codex-plugin/plugin.json` and `.gemini-plugin/plugin.json`, and their own
`skills/` tree. **The Claude-side manifest is the source; Codex and Gemini are
projections of it.** Each plugin appears as a separate entry in the Claude
marketplace manifest, and the Codex and Gemini marketplace manifests are
generated from it — which is why the marketplace validation asserts that all
three list exactly the same plugin names. Any runtime code for a plugin lives
under `apps/<plugin>/`.

`personal/` and `deprecated/` were removed from upstream and **must not be recreated**.

## Rules

1. Every skill in `engineering/`, `knowledge/`, `productivity/`, or `misc/` must be listed in the root `README.md` **and** in the owning plugin's `.claude-plugin/plugin.json` (e.g. `plugins/dev/.claude-plugin/plugin.json`). Skills in `in-progress/` appear in neither.
2. Codex and Gemini manifests are generated artifacts. Do not hand-edit `.agents/plugins/marketplace.json`, `.gemini-plugin/marketplace.json`, `plugins/*/.codex-plugin/plugin.json`, or `plugins/*/.gemini-plugin/plugin.json`; change the Claude-side manifests or plugin tree, then run `pnpm codex:manifests` and `pnpm gemini:manifests`. Pi packages are generated the same way: never hand-edit `plugins/*/package.json`; run `pnpm pi:manifests` after editing the Claude-side manifests or the plugin tree.
3. Each entry in `README.md` links the skill name to its `SKILL.md`.
4. Each bucket has its own `README.md` listing the bucket's skills with a one-line description.
5. `LICENSE` is Apache-2.0. The `NOTICE` file preserves Matt Pocock's original MIT copyright for the upstream-derived skills under `plugins/dev/skills/` — **do not remove or alter that attribution**. See ADR 0004.
6. Glossary docs use the ADR 0021 multi-context model: `.red/CONTEXT.md` is only
   a compatibility pointer to `.red/CONTEXT-MAP.md`; live glossary terms belong
   in `.red/contexts/{dev,memory,brain}/CONTEXT.md`, in the context that owns
   the term.
7. **All repo content is in English.** No Portuguese (or any other language) in committed files — SKILL.md, README, CHANGES, ADRs, comments, frontmatter descriptions. Chat with the user can stay Portuguese; the repo cannot.
8. **ask-red maintenance rule.** any skill add, rename, removal, or flow change must re-check `plugins/dev/skills/engineering/ask-red/SKILL.md`, update its Coverage Inventory and routes, and keep the `/red-doctor` router sync check green.

## Plugin activation (ADR 0067)

RedSkills plugins (`dev`, `memory`, `brain`) install their hooks **globally** on
every agent, but a plugin only runs in a directory whose `.red/config.yaml` sets
`plugins.<name>.enabled: true` (strict opt-in). No `.red/config.yaml`, or a block
without the explicit `enabled: true`, → the plugin stays fully inert there (no
bundle fetch, no hooks). `/red-setup` is the **only** thing authorized to
create a repository's `.red/` and to write the activation flags — no other code
path may create it. That authority is repository-scoped: the operator's
host-scoped `~/.red/redskilled/` belongs to the `redskilled` daemon and is
created only by `provisionRedskilledHome` (ADR 0130 Amendment 2), which
`/red-setup` provisions by calling (`redskilled provision`). The gate lives in `packages/shared/plugin-gate.ts` (consumed by the dev
launchers) with a mirrored inline copy in each of memory/brain's `bootstrap.mjs`;
keep the three in lockstep.

## Token-efficient terminal work

`rsp` is the repo-owned surface for token-efficient terminal work. Prefer the explicit wrappers when summarized output is enough:

- `rsp git status`, `rsp git diff`, `rsp git log`, `rsp git commit`, `rsp git push`
- `rsp gh pr list`, `rsp gh pr view`, `rsp gh issue list`, `rsp gh issue view`, `rsp gh run list`, `rsp gh run view`
- `rsp vitest`, `rsp vitest run`, `rsp cargo test`

Use `--brief` for compact summaries that keep enough inline context for normal debugging. Use `--terse` for large or repetitive output; lossy output mints an `el:<id>` handle, and `rsp show el:<id>` writes the original bytes back to stdout. Large `git diff` and `git log` output is threshold-gated and truncates by default; pass `--full` when exact inline output is required.

Use `rsp wait` as the standard waiting primitive for PR checks, GitHub Actions runs, releases, and local async commands. Never hand-write sleep polling loops; run `rsp wait` in a background shell and treat process exit as the signal.

Use raw commands when exact stdout/stderr is the behavior under test, when a wrapper does not support the command shape, or when resolving low-level git conflicts where every byte matters. In repos whose `.red/config.yaml` sets `rsp.enabled: true`, the pre-exec hook may rewrite simple supported commands to their `rsp` wrappers; absent that opt-in, call `rsp` explicitly. The ambient host instructions that replace legacy per-host terminal guidance are tracked in #1415 and should ship from the generated `apps/rsp/generated/AMBIENT-SKILL.md` surface.

## Repo-wide invariants

Some constraints span the whole repo but live in one package. They run in **every** gate run — including a cone-scoped one that touched a single package — via `pnpm -C apps/dev test:invariants`. The declared list is `apps/dev/src/core/repo-invariants.ts`; adding one is a single entry there plus the script it names.

- **Write a `*.toon` file with the TOON encoder, never `JSON.stringify`.** The decoder sniffs JSON-or-TOON and accepts both, so a JSON-written `.toon` looks correct locally and is wrong by policy.
- **New JSON file I/O under `apps/` or `packages/` must be fixed or classified.** The ratchet (`apps/dev/tests/toon-json-guard.test.ts`) names the offending path and the allowlist file, `.red/contracts/toon-json-file-io-allowlist.json`, when it fails. An `external` entry is a permanent exception and needs a one-line reason.
- **The `redskilled` daemon is the only thing that births a Worker.** Since the ADR 0130 cutover (#2851) the per-project runtime states an argv, a workspace and its own opaque project label and asks the host; it holds no `spawn`. A per-project module that can create a process fails the `host-owns-birth` ratchet (`apps/dev/tests/host-owns-birth-guard.test.ts`), which names the offending line and the route that replaced it. The declared sites live in `apps/dev/src/core/host-owns-birth-guard.ts`, and the list only ever grows — removing one is admitting a birth path back. **This is not about `spawnSupervisor`**: the project's own runtime process stays the project's; what the daemon owns is the Worker. A launch that cannot reach the daemon refuses (fail closed, rule 6) rather than falling back, because a Worker this process starts itself is one no admission verdict judged — outside the host budget, absent from the host event lane, reported by no surface.
- **Every shipped binary answers `--version` and `--help` without a working machine.** Discovery starts at the `bin` map, not at a hand-kept list, so a NEW binary inherits the obligations the moment its one-line `bin` entry lands (`apps/dev/tests/shipped-binary-guard.test.ts`, #2878). The binary must print `renderVersion(readBuildInfo(…))` — never an answer assembled from config, enablement, a store, or a socket, because `--version` is asked precisely when those are broken — and must route its arguments through `@reddb-io/shared/args` rather than walking `process.argv` itself. `--help` is asked under the same conditions and by someone usually already lost, so it must reach a usage constant on the STATIC front-door path (the entry or the one module it hands its command surface to) before touching a socket, config, a store or the filesystem (#2918); usage reachable only from a lazily-loaded subcommand module is not an answer. `process.argv` may be READ (handed whole to the parser, or sliced past the interpreter and the script); walking it with `includes`/`indexOf`/`find` fails. A packaged shim that forwards its whole argv inherits the bundle's answers, resolved through the owning package's `bundle` script. The obligations live in `apps/dev/src/core/shipped-binary-guard.ts`.
- **The Fleet and the Attempt stay extinct.** ADR 0130 removed the named-fleet registry, its name, its hooks, its `fleet_*` tools, the cross-host federated view, and the attempt record, retention and lane. A reader that reintroduces any of them fails the extinction ratchet (`apps/dev/tests/extinct-source-guard.test.ts`), which names the offending location and the route that replaced the source. **A module or symbol merely NAMED for an extinct concept fails the same way** (`EXTINCT_NAMES`, issue #2850): the guard matches module basenames and identifier tokens as a second dimension, because `attempt-accounting.ts` imported nothing extinct and so read clean while still keying resource accounting to a dead noun. Each name entry pairs the noun with what it owned rather than reddening the bare word — an ordinary retry is still an attempt. The inventories and the `EXTINCT_SOURCE_BASELINE` live in `apps/dev/src/core/extinct-source-guard.ts`; the baseline only ever shrinks — raising a count to admit a new reference is the regression it exists to refuse. Prose describing what was removed is documentation, not a reader: comments are stripped before matching.

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

**`/afk` is the modus operandi; `/go` is the ad-hoc exception.**

- Canonical `.red/` layout follows ADR 0098: tracked knowledge/config stays in `.red/{config.yaml,adr/,contexts/,agents/,contracts/,hooks/}`, plugin stores keep their documented homes (`memory/`, `brain/`, `wiki/`), durable machine state belongs under `.red/state/`, and `.red/tmp/` is 100% disposable scratch. Every writer must use a named lane; do not create loose files directly under `.red/tmp/`.
- State lanes: `.red/state/castle/` (durable engine state — supersedes the legacy `.red/state/afk/`, ADR 0105 boot-migration), `.red/state/rsp/`, `.red/state/statusline/`, `.red/state/branch-lock.yaml`, and `.red/state/red-skills.rdb`. Tmp lanes: `.red/tmp/{workers,go-workers,scout-workers,supervisors,monitors,claims,waits,rsp}/`, `.red/tmp/worktrees/{manual,feedback,landing,rebase,cascade,adopt,reconcile,docs}/`, `.red/tmp/logs/<yyyy-mm-dd>/`, `.red/tmp/scratch/`, and `.red/tmp/diagnostics/`. Worker workspaces are flat `workers/{id}/{issue}` (no attempt ordinal, ADR 0103); a worker's git worktree is the conventional direct child `workers/{id}/{issue}/worktree` (ADR 0105 as re-amended). Research reports live in gitignored `.red/researches/` until curated.
- **Maximize autonomous `/afk` drainage — that is the mission.** `/afk` is the default lane for **all work that is or should be a tracked issue**. The healthy steady state: every open executable issue is either `ready-for-agent` or gated for a *real, still-pending* reason. `ready-for-agent: 0` with a non-empty backlog is a **flow bug to diagnose, never a clean stop**: census the gates (`blocked:dependency` — verify each `req:*` target actually still pends, a delivered-but-open Spec strands its dependents; `needs-triage` stragglers; `ready-for-human` parks; `type:spec`) and clear the highest-leverage one. Humans enter the loop only for genuine decisions and broken flows.
- One-off concrete work goes through `/go "<demand>"` (ADR 0081): it mints a disposable `lane:go` issue, works in an isolated worktree under `.red/tmp/go-workers/`, runs the shared gate, and brings back a PR. **`/go` is only for genuinely untracked, ad-hoc, one-off demands** — never a fallback for issue-form work, never a menu option for tracked backlog. "It's already an issue" or "it should be one" means `/afk` owns it, not `/go`. A tracked backlog issue belongs to `/afk` because routing tracked work through `/go` drains the autonomous lane into human-babysat dispatches. Put a parked issue back in the queue with `/retake`.
- When working by hand instead (e.g. a slice the maintainer decided to land manually), work in an isolated worktree under `.red/tmp/worktrees/manual/<slug>/`; do not create sibling worktrees outside the repo.
- Create task branches with `git worktree add .red/tmp/worktrees/manual/<slug> -b <branch> origin/main`, not with `git checkout -b` or `git switch -c` in the primary checkout.
- Check out an EXISTING branch against the REMOTE ref: `git fetch origin <branch> && git worktree add .red/tmp/worktrees/manual/<slug> -B <branch> origin/<branch>`. Never the bare `git worktree add <dir> <branch>` — that resolves the LOCAL ref, which can trail `origin/<branch>`, so the work is built on a stale tip and the push comes back `non-fast-forward`.
- Commit the worktree, push the branch early, open a PR, monitor its checks, then merge it or park the issue/PR for `/hitl`.
- The agent never switches the primary checkout's branch; only the user does. With `plugins.dev.enabled: true`, the dev command proxy blocks agent-created worktrees outside registered `.red/tmp/` lanes and primary-checkout branch movement.
