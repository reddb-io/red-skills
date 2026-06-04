# ADR Index

Decision map for `.red/adr/` — the decision-record analogue of `CONTEXT-MAP.md`.
Generated/maintained via `/dev:review-adrs`. Grouped by theme; supersession and
stale notes inline.

> Resolved numbering collisions: the earlier `0039` consume ADR was renumbered
> to **0041**, and the superseded single-global `.red/` ADR was renumbered from
> **0005** to **0046**.

## Repo structure & contexts
- **0021** Multi-context plugin glossaries — *accepted*
- **0034** Repo splits DEFINITIONS from IMPLEMENTATION (`src/apps/…`) — partially superseded by **0039** (entrypoints fused) and **0041** (memory leaves)
- **0041** red-skills consumes `red-memory` + `red-ui` MCPs; stops building memory — partially supersedes 0034 *(renumbered from 0039)*
- **0046** A single global `.red/` shared by all plugins — *superseded by 0021*

## Bundle / fetch / release / version
- **0029** Runtime ships as esbuild bundle + `red` binary, fetched post-install by a bootstrap
- **0032** AFK ships as a committed dependency-free bundle — *shipping detail superseded by 0038; location by 0034*
- **0038** Dev runtime ships as a fetched Release asset, not a committed bundle — supersedes 0032's committed-bundle model
- **0039** Plugin entrypoints share one source, selected by a build role (unifies red-fetch/afk/code-nav/memory launchers)
- **0040** Version is a single source, written by one script; CLIs & MCP launchers version-aware
- **0052** One bundle-naming convention — all release assets under `./dist/` as `<app>[-<role>].bundle.min.mjs`; legacy `dist-bundle/*-cli.mjs` removed *(supersedes 0029's dual output for memory/brain)*

## AFK execution & lifecycle
- **0003** Native task surface mirrors AFK worker state
- **0008** `/afk` merges into the pinned branch, not always main
- **0015** Fleet supervisor is runner-portable; observability degrades per runner
- **0017** AFK records Reasoning attempts into Memory Graph best-effort
- **0026** AFK exposes lifecycle hooks as shell interceptors
- **0028** `<promise>` sentinel is the canonical attempt-exit signal
- **0030** AFK landing is lock-toggled; the PR carries the history
- **0031** Branch-lock value drives AFK base/merge; enforcement stays agent-only
- **0033** AFK agent execution runs on `@ai-hero/sandcastle`
- **0048** AFK merges without advice; in-process backpressure (`drift-guard` + feedback) is the guardrail — opt into waiting with `afk.merge.wait_for_review` *(refines 0030, 0008)*
- **0049** Model-tier routing embedded in the plugin (single config source), enforced by the shared skill + hooks + sandcastle trio, per runner *(relates 0003, 0033)*
- **0050** AFK salvages an uncommitted worktree when the inner agent emits DONE without committing (codex non-compliance net) *(complements 0047, 0028)*
- **0051** AFK attempt-progress guard resets on worktree edits, not just commits — stops false-stalling the productive-but-not-committing codex runner *(refines 0044, 0045)*

## Branch lock
- **0006** Branch lock enforces on the agent only, not the human terminal
- *(see also 0030, 0031)*

## Memory architecture & graph
- **0005** Memory plugin: three-layer RedDB architecture, local-first per-repo, MCP+CLI
- **0007** RedDB graph writes go through multi-model DML, not table inserts
- **0009** `dev` soft-uses `memory`, one-directional
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

## MCP / transport / surfaces
- **0013** Dev owns the codebase-understanding surface; memory owns the graph
- *(see also 0007, 0036, 0041)*

## Extraction / provider
- **0010** LLM conversation extraction routes through RedDB's AI provider, INFERRED-only
- *(see also 0035)*

## Skill curation & telemetry
- **0014** Memory owns skill telemetry and report-only curation
- **0016** `dev` owns the mutating Skill curator

## Licensing
- **0004** Relicense red-skills to Apache-2.0 with a NOTICE for upstream MIT

## Setup / handoff / orientation
- **0001** Explicit `/setup-red-skills` pointer only for hard dependencies
- **0002** Handoff precedence ladder and two-channel directive protocol
- **0018** Zoom-out grows impact analysis by composing graph primitives
