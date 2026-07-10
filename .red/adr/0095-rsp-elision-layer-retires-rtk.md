# rsp: the RedSkills elision layer — wrappers by contract, fail-closed interception, reversible elision over the Repo store

## Status

Accepted. Companion to ADR 0089 Amendment 1 (which retires RTK and widens the TOON scope); this ADR records the architecture of the replacement. Vocabulary lives in `.red/contexts/dev/CONTEXT.md`: **Elision**, **Elision handle**, **Passthrough**, **Normalization**, **Fidelity assertion**, **Repo store**, **rsp**.

## Context

RTK — the third-party CLI compression proxy — is being retired (evidence in ADR 0089 Amendment 1: savings concentrated in ~3 parsers, a 91,735-call zero-gain tail, 187k parse failures, and an upstream bug class of silent truncation and exit-code misreporting). Its root defect is structural, not incidental: **it scrapes human-facing output with regexes**, parsing a format the wrapped tool never promised to keep stable. Rebuilding those parsers in another language would rebuild the same bugs.

The replacement inverts that: where a machine contract exists, consume it; where none exists, elide only under a fidelity gate; and never discard bytes irrecoverably.

## Decision

### 1. One binary, `rsp`, three parts, neutral home

`rsp` is a single compiled binary in a neutral `packages/` package consumed by both `dev` and `memory` (neither plugin owns it; the dependency direction `memory → dev` is preserved). Its three parts travel in one artifact so they can never version-skew:

1. **Wrappers** — agent-ergonomic subcommands (`rsp git status`, `rsp test`, `rsp gh pr list`) that consume the wrapped tool's **machine contract** (`git status --porcelain`, `gh --json`, `vitest --reporter=json`, `cargo --message-format=json`) and emit TOON per the public spec. Wrappers never scrape human output. They apply the AXI principles: pre-computed aggregates, definitive empty states (`git empty` for a clean tree — lossless, no handle), next-step suggestions.
2. **Interception hook** — a stateless, daemon-free lookup that rewrites **only exact command forms on an allowlist** to their wrapper equivalents, and passes anything it does not recognize with certainty through untouched. No persistent process: the hook's job is a table match, and a daemon would add lifecycle failure modes (stale allowlist served silently) without a cache worth keeping warm.
3. **Elision store + retrieval** — see Decisions 4–6.

### 2. Passthrough is the default; elision is earned by measurement

Every filter ships with a benchmark fixture (raw output + expected elision). A **static admission gate** in CI activates a filter only when its median saving on real payloads clears a threshold; below it, the filter ships as Passthrough — present, tested, inactive. Activation is a versioned, reviewable assertion, never a runtime guess: the same command behaves identically on every machine at a given version.

### 3. Fidelity gates saving — two-axis benchmark

Each filter's fixture carries **Fidelity assertions**: questions the elided output must still answer ("which branch was pushed?", "how many tests failed?"). Token deltas are measured with a real tokenizer (not a chars/4 heuristic). **A filter that saves tokens while failing an assertion has destroyed information and fails CI.** Tokens-saved is never reported alone. A periodic agent-task eval (success rate, turns, cost against raw / RTK / external baselines) proves the whole system; it is too slow and noisy for per-PR CI, which is what the fixture gate is for.

### 4. The Elision-handle invariant, and Normalization as the one silent class

- **handle ⟺ elision**: an output carries an Elision handle if and only if bytes were removed from it. The original is persisted to the Repo store at elision time — not on passthrough (nothing removed), not on parser failure (raw output already delivered).
- **Normalization** — ANSI codes, carriage-return progress bars, trailing whitespace, repeated blank lines, and the lossless transcode of valid JSON to TOON — is a **closed allowlist** of provably information-free removals: silent, no handle. The JSON→TOON transcode is guarded per invocation by a round-trip check (`decode(encode(x)) === x`; any failure → Passthrough), turning "trust the encoder" into "verified just now" — it is the one generic compression that passes the honesty bar, since TOON encodes the full JSON data model. The allowlist grows only by explicit decision, mirroring the mechanical/intent split the AFK gate already uses.
- Aggressiveness is **chosen per call by the agent, with the loss class declared per level by the tool**: default and `--brief` are lossless (aggregates, definitive empties — no handle); `--terse` is lossy and therefore always mints a handle. The invariant holds at every level.

### 5. The Repo store: one RedDB file, logical separation by collection

`/setup-red-skills` — the sole authorized creator of `.red/` — provisions a single local RedDB file (`.red/red.rdb`) shared by the repo's plugins. The memory plugin's governed graph and `rsp`'s elision records live in **separate collections of the same file** (RedDB supports named graph and KV collections): one engine, one file, one connection — and the governed recall surface is never polluted by transient stdout. The memory plugin's existing `graph.rdb` migrates by a one-time mechanical repoint of `storePath`.

### 6. Retrieval and retention

- The elision marker line is actionable per AXI principle 9: `… elided 38 rows (+2.1kB) — rsp show el:7f3a`. **`rsp show <handle>`** prints the original — same binary, no MCP or memory-plugin dependency, works wherever `rsp` is installed.
- Retention is **TTL + byte budget** (`ttlDays`, `byteBudget` under the `rsp` block of `.red/config.yaml`, mirroring `l2.*` vocabulary), pruned amortized on write. An expired handle answers honestly: `expired <when> — re-run: <original command>`; never a mute error.

### 7. Per-repo opt-in, per-host asymmetry

- The **hook** activates only in a repo whose `.red/config.yaml` opts in, written by `/setup-red-skills` (ADR 0067 posture). No `.red/` → the hook is inert. This kills RTK's original sin — acting per-machine in every directory, asked or not. The wrappers, being ordinary CLIs, need no gate: calling them is always deliberate.
- **Host coverage respects reality:** wrappers work on all three agent CLIs by construction. Interception lands on Claude Code first (`PreToolUse`); OpenCode follows via the `apps/opencode-host` generated plugin if its pre-execution event supports rewriting; Codex — which has no pre-execution rewrite hook — is covered by ambient session instruction teaching the agent to call `rsp` directly. That is not a stopgap: it is the original AXI model, and it works even where every hook is unavailable.

### 8. Retirement path for RTK

Immediately: RTK's `[hooks] exclude_commands` is extended to disarm the zero-gain tail and all of `git` (where it misleads by design), keeping only its measured high-yield parsers (`cargo test`, `git commit`). RTK is uninstalled when `rsp` reaches **measured** parity on those parsers under the Decision 3 benchmark. No parallel operation beyond that overlap.

## Considered options

- **Narrow core only (no full coverage)** — rejected by the maintainer: parity matters; the answer to the risky tail is the admission gate + fidelity gate, not absence.
- **Full regex rebuild of RTK's parsers in TypeScript** — rejected: scraping human output is the root cause of the lie class; a rewrite inherits it.
- **Daemon + thin client on the hook path** — rejected: the hook is a pure table lookup; a daemon adds a stale-state failure class for no cacheable win.
- **Elision store inside the memory graph** — rejected: inverts the `memory → dev` dependency, dies where memory is inert, and pollutes governed recall with transient stdout. The shared-file/separate-collection design keeps the "one RedDB" goal without the coupling.
- **Per-machine hook activation (RTK model)** — rejected: acting where nobody opted in is the defining failure being replaced.
- **API-level conversation-history compression with cache-prefix alignment** (as in the external context-optimization layer) — explicit no. `rsp` operates at the shell boundary, compressing a command's output once, before it enters context. Conversation history belongs to the host CLI and provider (Claude Code already compacts and cache-aligns); a second layer over the same stream is the documented recipe for double-compression. Revisitable only by its own ADR.
- **Learned/ML compression** — explicit no as the deciding cutter. A model inferring what to drop is non-deterministic across versions and machines and cannot be audited by a fixture, which breaks the property the admission gate and Fidelity assertions stand on ("same command, same output, every machine, at a given version"). If it ever enters, it enters as a *proposer* whose output the deterministic gates validate — never as the final cutter.
- **Delegating hook rewrites to third-party agent-ergonomic CLIs** (the public AXI catalog: an official GitHub wrapper, community wrappers for npm/sqlite/Slack/Google Workspace, …) — rejected for the hook path. Two prior lessons decide it: the one-binary rule exists to make version skew impossible (a rewrite target installed separately can drift from the allowlist), and the supply-chain posture forbids unaudited third-party code on the automatic path between an agent and its credentials. The catalog's role is **prior art and fixture donor**: its field schemas, truncation shapes, and pre-computed aggregates inform `rsp`'s wrapper design, and our Fidelity fixtures benchmark `rsp` subcommands against the corresponding catalog tool — if `rsp gh` answers a fixture worse than the catalog's GitHub wrapper, that is an `rsp` bug. Deliberate human-initiated use of a vetted official catalog tool remains anyone's prerogative; automatic delegation, if ever wanted, enters by amendment with its own vetting gate. (House precedent: the human-review catalog entry was absorbed as `red-browser`/browser-bridge under PRD #907/#928 — absorb the design, never depend on the package.)

## Consequences

- A fourth versioned artifact exists (`rsp`'s neutral package) with its own admission-gated filter set; `dev` and `memory` both consume it.
- `/setup-red-skills` gains Repo-store provisioning; memory's `storePath` repoints to the shared file (one-time migration).
- The global `RTK.md` instruction file is eventually replaced by `rsp` ambient instructions generated per host (Claude/Codex/OpenCode) through the existing hook/manifest generation surface.
- Benchmarks against RTK and the external context-optimization layer are first-class deliverables, run with a real tokenizer and fidelity assertions — the numbers we publish mean what they say.
