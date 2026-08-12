# 0097 — TOON/TOONL is the on-disk format doctrine — big-bang cutover, sole-publisher dependency, wave-2 gate on TOONL v0.2

> **Amended by [Amendment 1 (2026-07-15)](#amendment-1-2026-07-15--toon-toolchain-version-sync-doctrine) and [Amendment 2 (2026-08-11)](#amendment-2-2026-08-11--official-package-channels-and-current-api-only).** The pnpm catalog is the single version truth for the toon toolchain; RedSkills consumes only the current public API from official package-manager releases; local paths, local builds and legacy codec subpaths are forbidden.

## Status

Accepted, with Amendments 1–2 (2026-07-15, 2026-08-11). Decisions resolved in the wayfinder charting + grilling sessions of 2026-07-14 (map #1765, tickets #1766–#1770), with the package-channel correction recorded while adopting toon 0.21.0 in Spec #3623. Extends ADR 0089 (Amendment 2 rebinds the encoder authority) from stdout to disk: ADR 0089 governs what agent-facing CLIs *emit*; this ADR governs what RedSkills *writes and keeps*. The original execution Spec is #1773.

## Context

ADR 0089 Amendment 1 made TOON the format for all agent-facing stdout, but every on-disk surface stayed JSON/JSONL: the AFK attempt firehose and `agent.log.jsonl`, `validation.jsonl`, `.red/state/afk-history.jsonl`, the fleet supervisor firehose, state snapshots, and the rsp telemetry spool. The deliberate split was "disk = JSONL forensic, stdout = TOON".

Two things changed:

1. **The formats are now ours.** `github:reddb-io/toon` ships TOON v3.3 (100% of the official spec corpus, 389 fixtures, Rust + JS implementations held to one behaviour) and **TOONL v0.1**, an append-only streaming extension designed for exactly the log/stream shape RedSkills writes — segment headers, positional rows, optional verified trailers, crash-tolerant open tails. It also ships `tq` (jq for TOON/TOONL, any-to-any conversion) and the dependency-free ESM package `@reddb-io/toon` with an O(record) incremental appender (`encodeLines().push()`).
2. **The savings were measured on live RedSkills data** (o200k_base, ticket #1769, all encodings verified lossless by round-trip): `afk-history.jsonl` **−30.6% tokens / −51.1% bytes**; `agent.log.jsonl` **−20.1%**; GitHub envelope log tails **−21.0%**; `validation.jsonl` −8.4% (prose-dominated cells). The attempt firehose three-way isolated the levers: flattening the `type=raw` double-encoding is worth −9.1% tokens (~−50% bytes on a 489 MB tree), while TOONL on top adds only −0.4pp — bytes and tokens are different economies because BPE already compresses escaped punctuation.

A structural fact forced the dependency decision: RedSkills already had a *private* workspace package named `@reddb-io/toon` wrapping the external `@toon-format/toon@2.3.0` (spec v3.2), while the toon repo publishes the same name with spec v3.3 + TOONL. Same-name-different-package is a foot-gun that had to be resolved, not managed.

## Decision

### 1. All on-disk structured data is TOON or TOONL

**Snapshots are TOON; append streams are TOONL.** Uniformity is total — machine-only states (`afk.state.json`, wait registries, statusline caches) migrate too, because "who reads this file" changes over time (every debugging incident puts a state file into an agent's context) and a single rule survives paraphrase: *structure on disk = TOON/TOONL*.

Exceptions, by contract rather than judgment:

- **External-protocol JSON** — Claude hook stdout, `opencode.json`, `package.json`, GitHub API payloads. The protocol owner sets the format.
- **Binary stores** — RedDB `.rdb` files.
- **Prose** — markdown, handoffs, ADRs. Doctrine unchanged: prose is never serialized.

### 2. One dependency, one publisher

The published `@reddb-io/toon` (from `reddb-io/toon`) is the **only** TOON/TOONL implementation RedSkills consumes. The toon repo is the sole publisher; RedSkills stops maintaining any format package. Concretely: `packages/toon` is deleted, the pnpm catalog repoints the same import name to npm (47 importing files unchanged), the house helpers `appendSummaryField`/`projectFields` move upstream into the published package's public API, and `@toon-format/toon` leaves the catalog. ADR 0089 Amendment 2 records the encoder-authority rebinding.

### 3. `tq` is a required host binary

Channel: the toon repo's checksum-verified `install.sh`, version-pinned via `TQ_VERSION`. `/red-setup` installs it as part of standard setup; `/red-doctor` flags absence or version drift as a red finding; skills docs migrate `jq` pipelines to `tq` with **no fallback lane** — after the cutover a host without `tq` is blind to its own logs, so a fallback would be disguised breakage, not graceful degradation. CI jobs that read TOONL get a pinned install step.

### 4. Migration is big-bang, but the trigger is detached

Legacy JSON/JSONL files are converted with `tq` at upgrade; writers and readers cut together in one release. Two hard constraints bound the bang:

- **Hooks and the statusline never wait** (the 2026-07-14 boot-freeze rule): the bootstrap *detects and triggers* the conversion but the work runs detached/background. Conversion of live streams requires a quiesced moment (no fleet, residents down); the migration refuses to run otherwise.
- **Readers format-sniff during the window**: until the background conversion completes, readers accept both formats by sniffing, then the sniff becomes dead code. History already converted is never rewritten again.

### 5. Wave 2 is gated on TOONL v0.2 — evolve the format, don't exempt the surface

Three surfaces are mechanically unsupported by TOONL v0.1: the fleet supervisor firehose (cursor-resume reads at byte offsets), the rsp telemetry spool (failed-line re-prepend splicing), and the attempt firehose (heterogeneous interleaved record shapes — measured 66–67% header-rotation thrash under v0.1 rotation). These do **not** become permanent JSONL exceptions; they wait for **TOONL v0.2**, whose requirements RedSkills delivered as the format's first dogfood consumer (ticket #1770): suffix-closure and concatenation-closure guarantees, a reader cursor convention (`byteOffset` + active header + rows-since-header), a header-preserving `tq trim --keep-last N`, tagged-row multiplexing for heterogeneous lanes, and line-splice as a documented non-goal (side-journal pattern instead).

### 6. The attempt-firehose flatten is wave 1 and format-independent

The `type=raw` double-encoding (whole runner events wrapped as JSON strings in `msg`, plus constant dead fields) is flattened as its own effort before any firehose format change: the event embeds as a real object, dead fields drop. Measured worth: ~−50% bytes on the 489 MB workers tree, −9.1% tokens. It is the prerequisite for any honest TOONL evaluation of that lane.

### 7. GitHub envelope log tails become TOON fences

When `agent.log.jsonl` migrates, the log tails posted into terminal-event envelopes switch to TOON fences. The primary readers are `/hitl` and `/retake` agents (−21.0% measured on the tail portion); humans read TOON without ceremony.

### 8. The two-regime output contract: lossless by default, optimization only when declared

`decode(encode(x)) === x` is the default contract for every TOON/TOONL producer — cell safety is the encoder's quoting, never pre-encode mutation of the data. Deliberate reduction (field projection, row capping, string truncation) is allowed **only** behind an explicit opt-in (`--compact` or equivalent) and must be declared in-band: the document marks that it was optimized and what was reduced, with recovery in reach — an Elision handle where the bytes are stored (rsp), or re-run-without-the-flag where the output is re-derivable (memory recall, reports). Silent lossy normalization is the forbidden pattern (the bug class this rule retires: `apps/memory/src/toon-output.ts` munging strings before encode).

## Consequences

- **The Spec (#1773) executes in two waves.** Wave 1: encoder cutover, firehose flatten, TOONL for uniform append lanes (`afk-history` with header-preserving cap handling, `agent.log.jsonl`, bench `runs.jsonl`), TOON for snapshots, the detached migration verb + format sniff, `tq` in `/red-setup`, `jq`→`tq` docs migration (the ask-red maintenance rule fires), envelope TOON fences, memory encoder fixes. Wave 2 (post-TOONL v0.2): supervisor firehose, telemetry spool, attempt-firehose TOONL.
- **red-castle writes TOONL at the source** — a plain npm dependency on the published `@reddb-io/toon` via the 2-repo flow, viable only after the first toon release. Until then red-castle surfaces stay as they are.
- **Everything is gated on the first `reddb-io/toon` release** (npm publish + prebuilt `tq` binaries; the repo is public but has no release yet). The upstream-helpers move (Decision 2) must land in the toon repo before that release so the RedSkills cutover is a pure catalog swap.
- **Expectations are anchored to measured numbers, not the synthetic benchmark**: −20 to −31% tokens where agents read in-context; near-zero token gain on envelope-class payloads; the firehose's win is disk, not tokens.
- **`rsp` keeps its role**: wrappers and elision govern *command output*; this ADR governs *files*. The transcode lane (`normalize.ts`) stops being the only TOON path for file reads once files are TOON-native.

## Related

- ADR 0089 (+ Amendments 1–2) — stdout doctrine; Amendment 2 rebinds the encoder authority this ADR depends on.
- ADR 0095 — rsp elision layer; source of the Elision-handle and declared-loss vocabulary that Decision 8 generalizes.
- ADR 0083 — liveness lanes; firehose mtime semantics are format-agnostic and unaffected by Decision 6.
- Wayfinder map #1765 and tickets #1766 (tq channel), #1767 (packages/toon fate), #1768 (two-regime contract), #1769 (measured savings), #1770 (TOONL v0.2 requirements) — the decision trail.
- `github:reddb-io/toon` — TOON v3.3, TOONL v0.1 (`docs/toonl-v0.1.md`), `tq`, `@reddb-io/toon`, `reddb-io-toon`.

## Notes

- **Bytes ≠ tokens.** The measurement round's core honesty: BPE already compresses escaped JSON punctuation, so byte-heavy wins (firehose flatten, −51% bytes on afk-history) do not translate 1:1 into token wins. Disk relief and token relief are separate ledgers; this ADR claims each only where measured.
- **The wave-2 gate is a format-evolution bet, not a deferral.** If TOONL v0.2 rejects a requirement (e.g. multiplexing), the affected surface's fallback is a *new decision*, not a silent JSONL exception.
- **History is never rewritten twice.** The one-time big-bang conversion is idempotent per file; already-TOONL files are never re-converted, and closed historical artifacts (GitHub comments, old envelopes) keep whatever format they were written in.

## Amendment 1 (2026-07-15) — toon toolchain version-sync doctrine

Two version-sync incidents during the 2026-07-15 wave-1 landings exposed failure modes in the original "one dependency, one publisher" decision: CI could still gain a **missing-`tq` gap** when a workflow read TOON/TOONL without the pinned host binary installed, and a **stale-lockfile landing race** could land a catalog/package bump before every consuming lockfile and derived pin site had converged. The fix is doctrine, not another hand-maintained checklist.

### 1. The pnpm catalog is the single version truth for the toon toolchain

The root `pnpm-workspace.yaml` catalog entry for `@reddb-io/toon` is the one source of the RedSkills toon toolchain version. Every other RedSkills-owned site that names the toon version or tag is derived from that catalog value or guarded against it: `TQ_VERSION` install steps, `/red-setup` remediation text, `/red-doctor` host-binary expectations, workflow pins, and docs examples.

No RedSkills surface owns an independent `tq` or `@reddb-io/toon` version. A mismatch is drift from the catalog, not a local override.

### 2. Upstream releases arrive as Release watcher auto-bump PRs

Routine `github:reddb-io/toon` releases enter RedSkills through the Release watcher. The watcher opens the auto-bump PR that updates the catalog version and the derived/guard-checked pin sites together, with the existing version-contract tests as the acceptance check.

Humans review and land the PR; AFK may fix a broken watcher PR. Humans and agents do not hand-sweep toon/tq pins as the normal release path, because that recreates the 2026-07-15 stale-lockfile race.

### 3. red-castle tracks ranges; consumers pin through lockfiles

red-castle expresses compatibility with `@reddb-io/toon` as a caret range. The exact version that executes in a RedSkills attempt is the consuming workspace's resolved lockfile entry, not a red-castle source edit. Re-pinning red-castle means updating the consuming workspace lockfile through the same catalog/watcher lane, never force-pinning the vendored source to chase an upstream release.

This keeps the producer contract and the consumer resolution separate: red-castle declares the range it supports; RedSkills decides the exact tested toolchain version at the workspace boundary.

## Amendment 2 (2026-08-11) — official package channels and current API only

The 0.21.0 adoption exposed two unsafe escape hatches in the original channel decision: CI referenced a GitHub release installer that was not published for the pinned version, while migration work could appear green by resolving a sibling toon checkout or the package's explicit legacy codec. Both make the tested implementation depend on machine-local state and allow RedSkills to keep producing an obsolete dialect.

### 1. RedSkills consumes published artifacts, never a sibling checkout

JavaScript imports resolve the catalog-pinned `@reddb-io/toon` package from the official npm registry. The `tq` binary is installed at the same catalog version from the official `reddb-io-tq` crate on crates.io using Cargo's locked install. A future immutable upstream release asset may become another official channel only when that exact tag and checksum-verified asset actually exist.

Local `file:`/`link:` dependencies, `../toon` paths, `target/debug/tq`, workspace overrides and ad-hoc binaries are forbidden in development contracts and especially in CI/CD. Tests must run against the same published artifacts that users install.

### 2. Only the current public codec is admissible

All writers and readers import the public `@reddb-io/toon` entrypoint and emit the current canonical format. The `@reddb-io/toon/legacy` subpath, legacy keyed-map collapse options and frozen historical fixtures are not compatibility lanes: RedSkills upgrades its persisted snapshots and tests to the current representation instead of continuing to produce an old dialect.

Canonical internal files carry the matching `.toon` or `.toonl` extension. Storing TOON bytes behind a `.json` or `.jsonl` filename is forbidden because the misleading contract causes tools and operators to select the wrong decoder.

TOONL writers use the current incremental API (`encodeToonlLines()`); finite record collections use `encodeRecords(records, options)`. A toolchain bump is incomplete until typechecking, canonical round trips, `tq` interop and generated bundles all pass without a legacy import or local-path resolution.

### 3. CI, setup and doctor enforce the same source of truth

CI installs `reddb-io-tq` into a job-local Cargo root with an exact version derived from the catalog and verifies the resulting binary. `/red-setup` and `/red-doctor` prescribe the same official crate channel. Guard tests reject sibling paths, local build outputs, legacy codec imports and version drift so a developer machine cannot silently make a release pipeline pass.
