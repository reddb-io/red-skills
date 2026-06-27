# ADR Index

Decision map for `.red/adr/` — the decision-record analogue of `CONTEXT-MAP.md`.
Generated/maintained via `/dev:review-adrs`. Grouped by theme; supersession and
stale notes inline.

> Resolved numbering collisions: the earlier `0039` consume ADR was renumbered
> to **0041**, and the superseded single-global `.red/` ADR was renumbered from
> **0005** to **0046**.
> **0043** was reserved/pending for PR #393 ("dev loop / ship") while that PR was
> in flight; do not reclaim the number.
> **0058** was reserved by an unmerged AFK "goal-predicate" branch (commit
> `daa3cc18`) that never landed on `main`; PRD #614 / issue #629 reassigned the
> number to **AFK bundle release channels** (the goal-predicate branch must pick
> a free number if it is ever revived).

## Repo structure & contexts
- **0021** Multi-context plugin glossaries — *accepted* (predates the `brain` plugin; the multi-context model now spans `dev`/`memory`/**`brain`** — see the *Brain plugin* section and `.red/contexts/brain/`)
- **0034** Repo splits DEFINITIONS from IMPLEMENTATION (`apps/…` + `packages/…`) — partially superseded by **0039** (entrypoints fused), **0041** (memory leaves), and **0060** (layout relocated to root with a pnpm catalog)
- **0041** red-skills consumes `red-memory` + `red-ui` MCPs; stops building memory — partially supersedes 0034 *(renumbered from 0039; **REVERSED by Amendment 1, 2026-06-20 — memory stays in red-skills as the local `red-memory` MCP; the repo split is cancelled**)*
- **0060** Workspaces move to root `apps/` + `packages/` with a pnpm `catalog:` for shared versions — relocates 0034's `src/apps`/`src/packages` layout (conventional Turborepo); `@reddb-io/sdk` stays per-app-pinned for the bundler
- **0046** A single global `.red/` shared by all plugins — *superseded by 0021*

## Brain plugin
- **0063** The `brain` plugin is a first-class red-skills plugin (RedDB knowledge repo: captures + graph connections, folder-level brains) and the **third** multi-context glossary context; stays in red-skills for now, may follow the 0041 split to a `red-brain` repo when mature *(amends 0021; reuses 0038/0040 fetch+version, 0034/0060 layout, 0057 Hermes)*
- **0057** `red-hermes` is a fetched, never-vendored black-box dependency of the `brain` plugin — reached via `hermes mcp serve`, fetched as a Release asset (0038 model), version pinned (0040), 10-tool contract; MIT attribution in `NOTICE` (0004) *(downstream fetch/launcher blocked on red-hermes releases, same shape as #378)*

## Bundle / fetch / release / version
- **0029** Runtime ships as esbuild bundle + `red` binary, fetched post-install by a bootstrap — the fetch model for the `dev`/`code-nav` bundles (0041's memory-fetch was reversed 2026-06-20; memory runs from the in-repo `apps/memory` build)
- **0032** AFK ships as a committed dependency-free bundle — *shipping detail superseded by 0038; location by 0034*
- **0038** Dev runtime ships as a fetched Release asset, not a committed bundle — supersedes 0032's committed-bundle model
- **0039** Plugin entrypoints share one source, selected by a build role (unifies red-fetch/afk/code-nav/memory launchers)
- **0040** Version is a single source, written by one script; CLIs & MCP launchers version-aware
- **0052** One bundle-naming convention — all release assets under `./dist/` as `<app>[-<role>].bundle.min.mjs`; legacy `dist-bundle/*-cli.mjs` removed *(supersedes 0029's dual output for memory/brain)*
- **0058** AFK bundle release channels — `stable` (default, version-pinned = today) and `canary` (opt-in, floating `canary` tag) resolved by the 0038 launcher from `RED_SKILLS_CHANNEL`/`plugins.dev.afk.release.channel`; promotion is a tag move gated on the proof-by-drain history telemetry *(PRD #614 / #629; extends 0038/0039, config via 0042)*

## AFK execution & lifecycle

> Many ADRs in this group predate the bash→TypeScript port (ADR 0032/0034 deleted
> the `scripts/*.sh` runtime). Their references to `*.sh` files (e.g. `supervisor.sh`,
> `afk.sh`) are **historical parity anchors** — the TS runtime mirrors that behaviour;
> the shell files no longer exist. The decisions stand; only the implementation moved.

- **0003** Native task surface mirrors AFK worker state
- **0008** `/afk` merges into the pinned branch, not always main
- **0015** Fleet supervisor is runner-portable; observability degrades per runner
- **0017** AFK records Reasoning attempts into Memory Graph best-effort
- **0026** AFK exposes lifecycle hooks as shell interceptors — extended by **0045** with the periodic `on_heartbeat` hook
- **0028** `<promise>` sentinel is the canonical agent-authored attempt-exit signal — runtime-initiated exits are mapped by **0044** (`timeout`) and **0047** (no-sentinel salvage)
- **0030** AFK landing is lock-toggled; the PR carries the history
- **0031** Branch-lock value drives AFK base/merge; enforcement stays agent-only
- **0033** AFK agent execution runs on a sandcastle-shaped substrate *(refined by 0061: the substrate is the vendored `@reddb-io/red-castle` submodule)*
- **0061** AFK execution substrate is the vendored `@reddb-io/red-castle` git submodule under `packages/`, consumed as TypeScript source (no build); replaces the `@ai-hero/sandcastle` npm dependency *(refines 0033)*
- **0044** AFK attempt progress guard aborts stalled-but-busy attempts to `blocked:stalled` without requiring a promise sentinel — *§4 "no-sandbox only" superseded by **0054***
- **0055** AFK reconcile — a no-agent worker mode that lands a parked green branch *(the implemented worker-mode, #558; realises 0056)*
- **0056** AFK landability reconciler: parked-but-green branches self-land via a no-agent reconcile worker *(the umbrella design — generalises 0047/0050 to a continuous reconcile of `timeout`/`no-sentinel`; realised by 0055; relies on 0008 gate, 0030 landing)*
- **0045** AFK externalized proof-of-life: heartbeat record, state field, and periodic `on_heartbeat` hook *(extends 0026; follows 0044; §4 "no-sandbox only" superseded by **0054**)*
- **0047** AFK salvages a no-sentinel branch that already passes feedback *(complements 0028)*
- **0048** AFK merges without advice; in-process backpressure (`drift-guard` + feedback) is the guardrail — opt into waiting with `afk.merge.wait_for_review` *(refines 0030, 0008)*
- **0049** Model-tier routing embedded in the plugin (single config source), enforced by the shared skill + hooks + sandcastle trio, per runner *(relates 0003, 0033)*
- **0050** AFK salvages an uncommitted worktree when the inner agent emits DONE without committing (codex non-compliance net) *(complements 0047, 0028)*
- **0051** AFK attempt-progress guard resets on worktree edits, not just commits — stops false-stalling the productive-but-not-committing codex runner *(refines 0044, 0045)*
- **0054** AFK arms the attempt guard + heartbeat under docker/podman isolation via an attempt-dir bind mount; lane-idle reaper stays host-only *(supersedes 0044 §4 / 0045 §4; relies on 0033; absorbs #284 docker E2E)*
- **0059** OpenCode is the third AFK runner, addressing OpenRouter through its own `openrouter/<vendor>/<model>` slug + the `OpenCodeOptions.env` auth seam; accepted only as an explicit pin, never auto-sniffed. **Amended (1):** endpoint-agnostic — accepts any `<provider>/<model>` slug, propagates the first-set auth env-var (OPENAI_API_KEY > MINIMAX_API_KEY > OPENROUTER_API_KEY) through `OpenCodeOptions.env`; OpenCode owns endpoint resolution. **Amended (2):** MiniMax subscription API as the concrete case that motivated the endpoint-agnostic property *(follows 0003, 0033, 0049; refined by 0062)*
- **0070** `claude-minimax` is a fourth AFK runner pointing at MiniMax's Anthropic-compatible endpoint (`api.minimax.io/anthropic`), reusing the unchanged `claude-code` provider with env-var injection (`MINIMAX_API_KEY` → `ANTHROPIC_API_KEY/ANTHROPIC_BASE_URL`); model pinned to `MiniMax-M3`, effort capped to `low`; explicit-pin only, never auto-sniffed (PRD #788, spike gate #790) *(extends 0003, 0033, 0049; parallel to 0059 OpenCode; relates 0062)*
- **0062** AFK Actions lane is a repo-portable composite action (`.github/actions/afk-attempt`) under a thin reusable workflow (triggers + trust gate); execution carries its own red-skills checkout so the launcher resolves in any adopter repo *(refines 0059; reuses 0038/0039 launcher, 0033/0061 seam, 0056 gate)*
- **0065** AFK worker vitals are one canonical `WorkerVitals` vocabulary across the chain (red-castle → state → statusline/monitor/dashboard); kills name drift (`thinking`→`reasoning`, drop `diff_*` alias, `last_progress_at`→`last_commit_at`), adds the honest `last_event_at` liveness clock + per-worker cost from red-castle's `usage` event *(proposed; formalizes 0044/0045; relies on 0033/0061 seam)*
- **0066** AFK atomic GitHub-native claim: a pure reconciler over server-ordered claim comments decides the single winner; `running` and friends become an observability projection, never the lock *(claim-substrate slice of PRD #614 / #622, which call it "ADR 0056"; chosen primitive = structured claim-comment ordering, rejecting assignee CAS + check-run; reuses the `core/mirror.ts` pure-reconciler/injected-client shape; #434 mkdir lock demoted to same-host dedupe; proceeds into 0030/0048 landing)*
- **0071** AFK feedback-gate resilience program — six coordinated fixes for the seven worker-failure patterns from the claude-minimax spike: INFRA/SEMANTIC failure split (`feedback-failed-infra` + `validation-infra` bounded retry), baseline probe (downgrade pre-existing main failures), tracked post-checkout submodule hook, cross-session worktree cache (SHA-invalidated), process-safety death diagnostic, opt-in rebase-onto-base; `tests/afk-resilience.test.ts` codifies all seven patterns *(extends 0008 merge gate, 0055 reconcile, 0061 red-castle source; motivated by 0070 spike; preserves the semantic `blocked:validation` human-escalation contract)*

## Branch lock
- **0006** Branch lock enforces on the agent only, not the human terminal
- *(see also 0030, 0031)*

## Memory architecture & graph

> **0041's memory-to-separate-repo split was reversed (Amendment 1, 2026-06-20).**
> The memory runtime stays in red-skills — it is built from `apps/memory` and
> served by the local `red-memory` MCP (`plugins/memory/.mcp.json`). These ADRs
> describe the memory **substrate/domain** and their decisions stand; their
> implementation lives in `apps/memory`, not a separate `red-memory` repo.

- **0005** Memory plugin: three-layer RedDB architecture, local-first per-repo, MCP+CLI
- **0007** RedDB graph writes go through multi-model DML, not table inserts
- **0009** `dev` soft-uses `memory`, one-directional — gate mechanism partially superseded by **0042**, then replaced by **0067**'s strict per-directory `enabled` gate; soft-use direction stands
- **0011** Ephemeral-tier expiry enforced client-side, not engine TTL
- **0012** Community-coloured graph needs a per-node assignment from the engine
- **0019** Memory graph is the substrate for codebase mapping
- **0020** Memory tier maps directly to VERSIONED collection policy
- **0022** Vector is a seed provider for Memory recall
- **0023** Memory moat foundation before surface expansion — amended by **0072** for the next delivery cycle: governed write MCP and cross-agent smoke test ship before the full foundation is complete
- **0024** AS OF recall is read-only over RedDB VCS
- **0025** Memory event log is append-only and non-versioned
- **0027** Memory operates as a closed loop via hooks, PR-merge automation, CI drift guards
- **0035** Extraction schema splits closed structural type from open engineering code
- **0036** Memory transports are adapters over the operation registry
- **0037** Memory benchmark measures substrate superiority on a curated corpus, not LOCOMO
- **0053** Provider tidy is report-only governance until explicit soft-merge approval
- **0072** Memory ships governed write surface before completing the moat foundation — first write surface is `memory_store_evidence` over MCP plus CLI, direct storage is limited to low-blast-radius source-cited validation evidence, and the cross-agent smoke test must show provenance plus policy outcome *(amends 0023; informed by Headroom competitive analysis)*

## MCP / transport / surfaces
- **0013** Dev owns the codebase-understanding surface; memory owns the graph — post-0041, `dev` consumes project memory through the `red-memory` MCP rather than an in-repo Memory CLI
- *(see also 0007, 0036, 0041)*

## Extraction / provider
- **0010** LLM conversation extraction routes through RedDB's AI provider, INFERRED-only
- *(see also 0035)*

## Skill curation & telemetry
- **0014** Memory owns skill telemetry and report-only curation — runtime stays in `apps/memory` (0041 split reversed 2026-06-20); ownership/report-only boundary stands
- **0016** `dev` owns the mutating Skill curator — post-0041 it consumes report-only curator output through `red-memory` MCP, not an in-repo `memory` CLI

## Licensing
- **0004** Relicense red-skills to Apache-2.0 with a NOTICE for upstream MIT
- *(see also 0057 — MIT attribution for the fetched `red-hermes` brain dependency)*

## Setup / handoff / orientation
- **0001** Explicit `/setup-red-skills` pointer only for hard dependencies
- **0002** Handoff precedence ladder and two-channel directive protocol
- **0018** Zoom-out grows impact analysis by composing graph primitives
- **0042** Plugin configuration is unified under `.red/config.yaml`, namespaced by `plugins.<name>` *(partially supersedes 0009 gate mechanism; carries 0026 hooks and 0041 migration config; its block-presence opt-in is replaced by 0067's `enabled` gate)*
- **0043** RedSkills teaches and enforces an interactive development loop — accepted from PR #393's reserved/pending "dev loop / ship" slot *(refines 0006; relates 0030/0031; depends on 0042)*
- **0067** Per-directory plugin activation gate — globally-installed hooks stay inert until `.red/config.yaml` sets `plugins.<name>.enabled: true` (strict opt-in); `/setup-red-skills` is the sole creator of `.red/` and the only way to enable a plugin *(supersedes the 0042/0009 block-presence opt-in gate; builds on 0042 config + 0038/0039 launchers)*
- **0075** OpenCode provider block is the canonical shape that hosts the AFK opencode runner on a developer machine — `apps/opencode-host/` is the **adapter layer** that emits `opencode.json`'s `provider>` block from the same `plugins.dev.afk.models.opencode.*` block AFK already reads, applying the 0059 env-precedence rule. **Amendment 3 of 0059** *(Slice 1 of the opencode-as-host plan; skills/hooks/MCP/agents are Slices 2-5)*
- **0076** OpenCode skills are the same `SKILL.md` files Claude/Codex already publish — flat-symlinked, name-validated, never rewritten. Slice 2 (skills half) of the opencode-host plan; preserves ADR 0034 (defs vs impl) by symlinking the source rather than generating a parallel `tool` per skill.
- **0077** OpenCode plugin events replace Claude/Codex `claude.hooks.json` and `codex.hooks.json` with one TS module per event. Slice 2 (hooks half) of the opencode-host plan; rewrites `${CLAUDE_PLUGIN_ROOT}`/`${CODEX_PLUGIN_ROOT}` to opencode's `directory` context, splits the file-per-event convention, and warns-and-continues on unsupported events.
