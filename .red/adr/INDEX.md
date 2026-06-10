# ADR Index

Decision map for `.red/adr/` — the decision-record analogue of `CONTEXT-MAP.md`.
Generated/maintained via `/dev:review-adrs`. Grouped by theme; supersession and
stale notes inline.

> Resolved numbering collisions: the earlier `0039` consume ADR was renumbered
> to **0041**, and the superseded single-global `.red/` ADR was renumbered from
> **0005** to **0046**.
> **0043** was reserved/pending for PR #393 ("dev loop / ship") while that PR was
> in flight; do not reclaim the number.

## Repo structure & contexts
- **0021** Multi-context plugin glossaries — *accepted*, includes `brain` context
- **0034** Repo splits DEFINITIONS from IMPLEMENTATION (`src/apps/…`) — partially superseded by **0039** (entrypoints fused) and **0041** (memory leaves)
- **0041** red-skills consumes `red-memory` + `red-ui` MCPs; stops building memory — partially supersedes 0034 *(renumbered from 0039)*
- **0046** A single global `.red/` shared by all plugins — *superseded by 0021*
- **0055** AFK reconcile — a no-agent worker mode that lands a parked green branch
- **0057** `red-hermes` is a fetched black-box dependency of the `brain` plugin; `brain` context documented in **0021**

## Brain plugin & contexts
- **0021** Multi-context plugin glossaries — *accepted*, includes `brain` context — post-0041, brain is a new plugin alongside dev/memory
- **0057** `red-hermes` is a fetched, never-vendored black-box dependency of the `brain` plugin — reached via `hermes mcp serve`, fetched as a Release asset (0038 model), version pinned (0040), 10-tool contract; MIT attribution in `NOTICE` (0004) *(downstream fetch/launcher blocked on red-hermes releases, same shape as #378)*

## Bundle / fetch / release / version
- **0029** Runtime ships as esbuild bundle + `red` binary, fetched post-install by a bootstrap — post-0041, the memory runtime is fetched from the `red-memory` repo rather than built in red-skills
- **0032** AFK ships as a committed dependency-free bundle — *shipping detail superseded by 0038; location by 0034*
- **0038** Dev runtime ships as a fetched Release asset, not a committed bundle — supersedes 0032's committed-bundle model
- **0039** Plugin entrypoints share one source, selected by a build role (unifies red-fetch/afk/code-nav/memory launchers)
- **0040** Version is a single source, written by one script; CLIs & MCP launchers version-aware
- **0052** One bundle-naming convention — all release assets under `./dist/` as `<app>[-<role>].bundle.min.mjs`; legacy `dist-bundle/*-cli.mjs` removed *(supersedes 0029's dual output for memory/brain)*

## AFK execution & lifecycle
- **0003** Native task surface mirrors AFK worker state — ⚠ stale on bash implementation (TypeScript runtime at `src/apps/dev/`)
- **0008** `/afk` merges into the pinned branch, not always main — *implementation superseded by **0030** (lock-toggled landing); pinned-branch decision stands*
- **0015** Fleet supervisor is runner-portable; observability degrades per runner — ⚠ stale on bash implementation (TypeScript runtime at `src/apps/dev/`)
- **0017** AFK records Reasoning attempts into Memory Graph best-effort
- **0026** AFK exposes lifecycle hooks as shell interceptors — ⚠ stale on shell implementation; hook configuration is now TypeScript under ADR 0042 and `src/apps/dev/` — extended by **0045** with the periodic `on_heartbeat` hook
- **0028** `<promise>` sentinel is the canonical agent-authored attempt-exit signal — runtime-initiated exits are mapped by **0044** (`timeout`) and **0047** (no-sentinel salvage)
- **0030** AFK landing is lock-toggled; the PR carries the history
- **0031** Branch-lock value drives AFK base/merge; enforcement stays agent-only
- **0033** AFK agent execution runs on `@ai-hero/sandcastle`
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
- **0059** OpenCode is the third AFK runner, addressing OpenRouter through its own `openrouter/<vendor>/<model>` slug + the `OpenCodeOptions.env` auth seam; accepted only as an explicit pin, never auto-sniffed. **Amended (1):** endpoint-agnostic — accepts any `<provider>/<model>` slug, propagates the first-set auth env-var (OPENAI_API_KEY > MINIMAX_API_KEY > OPENROUTER_API_KEY) through `OpenCodeOptions.env`; OpenCode owns endpoint resolution. **Amended (2):** MiniMax subscription API as the concrete case that motivated the endpoint-agnostic property *(follows 0003, 0033, 0049)*

## Branch lock
- **0006** Branch lock enforces on the agent only, not the human terminal
- *(see also 0030, 0031)*

## Memory architecture & graph
> **Post-0041 migration note:** Except for **0009** (soft-use boundary) and **0042** (plugin config), the memory ADRs below (**0005, 0007, 0011, 0012, 0014, 0019–0027, 0035–0037, 0053**) document the **retired in-repo** `memory` plugin as it existed before spin-off (ADR 0041). Implementation now lives in the `red-memory` repo, bundled as an MCP; the decision record remains authoritative for red-skills architecture, but implementation details are archived here.

- **0005** Memory plugin: three-layer RedDB architecture, local-first per-repo, MCP+CLI
- **0007** RedDB graph writes go through multi-model DML, not table inserts
- **0009** `dev` soft-uses `memory`, one-directional — gate mechanism partially superseded by **0042**; soft-use direction stands
- **0011** Ephemeral-tier expiry enforced client-side, not engine TTL
- **0012** Community-coloured graph needs a per-node assignment from the engine
- **0019** Memory graph is the substrate for codebase mapping
- **0020** Memory tier maps directly to VERSIONED collection policy
- **0022** Vector is a seed provider for Memory recall
- **0023** Memory moat foundation before surface expansion
- **0024** AS OF recall is read-only over RedDB VCS
- **0025** Memory event log is append-only and non-versioned
- **0027** Memory operates as a closed loop via hooks, PR-merge automation, CI drift guards
- **0035** Extraction schema splits closed structural type from open engineering code
- **0036** Memory transports are adapters over the operation registry
- **0037** Memory benchmark measures substrate superiority on a curated corpus, not LOCOMO
- **0053** Provider tidy is report-only governance until explicit soft-merge approval

## MCP / transport / surfaces
- **0013** Dev owns the codebase-understanding surface; memory owns the graph — post-0041, `dev` consumes project memory through the `red-memory` MCP rather than an in-repo Memory CLI
- *(see also 0007, 0036, 0041)*

## Extraction / provider
- **0010** LLM conversation extraction routes through RedDB's AI provider, INFERRED-only
- *(see also 0035)*

## Skill curation & telemetry
- **0014** Memory owns skill telemetry and report-only curation — post-0041 runtime moves to `red-memory`; ownership/report-only boundary stands
- **0016** `dev` owns the mutating Skill curator — post-0041 it consumes report-only curator output through `red-memory` MCP, not an in-repo `memory` CLI

## Licensing
- **0004** Relicense red-skills to Apache-2.0 with a NOTICE for upstream MIT
- *(see also 0057 — MIT attribution for the fetched `red-hermes` brain dependency)*

## Setup / handoff / orientation
- **0001** Explicit `/setup-red-skills` pointer only for hard dependencies
- **0002** Handoff precedence ladder and two-channel directive protocol
- **0018** Zoom-out grows impact analysis by composing graph primitives
- **0042** Plugin configuration is unified under `.red/config.yaml`, namespaced by `plugins.<name>` *(partially supersedes 0009 gate mechanism; carries 0026 hooks and 0041 migration config)*
- **0043** RedSkills teaches and enforces an interactive development loop — accepted from PR #393's reserved/pending "dev loop / ship" slot *(refines 0006; relates 0030/0031; depends on 0042)*
