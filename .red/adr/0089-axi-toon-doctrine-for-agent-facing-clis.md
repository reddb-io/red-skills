# 0089 — AXI + TOON is the doctrine for every agent-facing CLI

> **⚠️ Partially amended by [Amendment 1 (2026-07-09)](#amendment-1-2026-07-09--rtk-retired-toon-scope-widened-to-all-structured-data).** Two points below no longer hold: the "RTK stays the safety net" consequence (RTK is retired by ADR 0095) and Decision 2's tabular-only TOON boundary (TOON now covers all structured data at every depth). The rest of the doctrine stands unchanged.
>
> **⚠️ Partially amended by [Amendment 2 (2026-07-14)](#amendment-2-2026-07-14--encoder-authority-moves-to-the-published-reddb-iotoon-two-regime-output-contract).** The encoder authority is no longer `@toon-format/toon`/spec v3.2 — it is the published `@reddb-io/toon` (spec v3.3 + TOONL, `github:reddb-io/toon`), and every producer is bound to the two-regime contract: lossless by default, optimization only when explicitly requested and declared in-band.

## Status

Accepted, with Amendment 1 (2026-07-09) and Amendment 2 (2026-07-14). Codifies the AXI ("Agent eXperience Interface") design-time principles and the TOON output format as the RedSkills standard for every CLI whose primary reader is an agent. Implements Track 1C/F of PRD #907; the first application slice is #918.

## Context

Every RedSkills CLI that an agent reads — `monitor`, `dashboard`, `daily-review`, `statusline`, and the dev bundle subcommands — spends tokens on output the agent must parse before it can act. Today that spend is uncontrolled at the source and only clawed back after the fact.

Two facts frame the decision:

1. **RTK compresses after the fact.** RTK is a proxy that filters noisy command output *after* a tool has already produced it (60–90% savings on dev operations). It proves the token thesis empirically — the noise is real and worth removing — but it is a downstream patch. It cannot change what a CLI chooses to emit; it can only shrink what already exists.

2. **There is no design-time spec.** Nothing tells a new CLI *how to be cheap at the source* — how many fields a list item should carry, what an empty result looks like, whether to suggest the next command, which serialization to emit. Each surface reinvents its output shape, and the noisiest ones (JSON blobs with ten fields per row, ambiguous empty output, no next-step hint) force extra round-trips that cost far more than the raw bytes.

RTK answers "how do we shrink this?" AXI answers "why is it big in the first place?" The two are complementary: **AXI designs cheap output; RTK is the safety net for output we do not control.** The maintainer's steer (2026-06-30, 2026-07-01) is to apply AXI for *real* savings at the source and measure the delta, not to lean on RTK as the only lever.

## Decision

### 1. The 10 AXI principles are the design-time contract for agent-facing CLIs

Every CLI whose primary reader is an agent is designed against these ten principles. They are the design-time spec that RTK's after-the-fact compression cannot supply:

1. **Token-efficient output** — emit TOON, not JSON, for list/tabular output (~40% fewer tokens; see Decision 2).
2. **Minimal default schemas** — 3–4 fields per list item by default, not 10. Extra fields are opt-in, never the default.
3. **Content truncation** — truncate large text with a size hint and a `--full` escape hatch; never dump unbounded blobs.
4. **Pre-computed aggregates** — include the counts and rollup statuses the agent would otherwise compute with a second call.
5. **Definitive empty states** — an explicit `0 results` (with the next command to try), never ambiguous empty output the agent must guess at.
6. **Structured errors & exit codes** — idempotent mutations, structured error payloads, and no interactive prompts in agent contexts.
7. **Ambient context** — install opt-in session integrations first, then offer an on-demand skill; do not force the agent to discover state.
8. **Content first** — running with no arguments shows live data, not help text.
9. **Contextual disclosure** — end each output with a next-step suggestion ("run `X` to …") so the agent needs one fewer guess.
10. **Consistent way to get help** — a concise per-subcommand reference reachable the same way everywhere.

**These are targets, not a lint.** A surface adopts them incrementally, slice by slice, measured (Decision 4). A CLI is not rejected for missing one; it is scheduled to close the gap. The [AXI + TOON doctrine doc](../contexts/dev/axi-toon-doctrine.md) restates these ten as a copy-ready checklist for CLI authors.

### 2. TOON is the output format for list and tabular data

**TOON (Token-Oriented Object Notation) is the default serialization for agent-facing list/tabular output.** It is a compact encoding of the JSON data model — same objects, arrays, and primitives — that declares uniform-array fields once and streams row values line by line, dropping the repeated property names and delimiter punctuation JSON pays for on every row. Public spec: <https://toonformat.dev/>.

The measured claim: **~40% fewer tokens than JSON on mixed-structure data, with equal-or-better model retrieval accuracy** (76.4% vs JSON's 75.0% across four models in the format's own benchmark). The savings come precisely from the shape AXI's minimal-schema principle already pushes toward — few fields, many rows.

Concrete example — the same worker roster:

```json
{
  "workers": [
    { "id": "wEW5N", "issue": 910, "state": "active" },
    { "id": "wBXI6", "issue": 943, "state": "merged" }
  ]
}
```

```toon
workers[2]{id,issue,state}:
  wEW5N,910,active
  wBXI6,943,merged
```

**Scope of TOON, stated as a rule so it is not over-applied** *(superseded by Amendment 1 — the boundary is now "all structured data at every depth; prose never serialized")*:

- **Use TOON for** uniform arrays of objects — the roster, issue list, PR list, DORA rows. This is where the win is largest and retrieval accuracy holds.
- **Do not force TOON onto** a single scalar, a one-off nested config object, or free-form prose. TOON's win is tabular; a lone object gains nothing and reads worse. JSON (or plain text) stays correct there. *(superseded by Amendment 1)*
- **Human-facing rendering is unaffected.** A CLI may still render a pretty table for a human; the doctrine governs the *agent-facing* serialization path. A `--json` escape hatch stays available for consumers that need raw JSON.

The [doctrine doc](../contexts/dev/axi-toon-doctrine.md) records the concrete TOON line format (delimiters, summary line, human-readability rules) and a TOON-vs-JSON-vs-prose contrast table.

### 3. Adoption order — the noisiest agent-facing surfaces first

Surfaces adopt AXI + TOON in this order, chosen by how much an agent reads them and how noisy they are today:

1. **`monitor`** — the highest-frequency agent read (fleet dashboards, per-tick reports). First application slice = **#918**.
2. **`dashboard`** — issue/PRD/worker/flow/DORA rollups.
3. **`daily-review`** — delivered-work and cycle-time report.
4. **`statusline`** — the always-on footer.

The dev bundle's other subcommands adopt opportunistically as they are touched. **Order is by noise-and-frequency, not by ease.** `monitor` leads because it is read most.

### 4. Measurement plan — prove the delta, do not assert it

Adoption is not "done" until the saving is measured. The plan:

1. **Pick the three noisiest agent-facing outputs** across the target surfaces (candidates: `monitor`'s per-tick fleet report, `dashboard`'s combined rollup, `daily-review`'s delivered-work table).
2. **TOON them** — convert the agent-facing serialization path from JSON to TOON, keeping the same data.
3. **Report the token delta** — measure before/after token count on representative real payloads and record the percentage saved. The ~40% figure is the expectation to test, not a number to quote unmeasured.

The measurement is a first-class deliverable of the rollout, reported per slice, so the doctrine stays honest about whether the source-level design actually pays off — the same evidentiary bar RTK's `rtk gain` sets for after-the-fact savings.

## Consequences

- **New agent-facing CLIs start AXI-shaped.** The ten principles are the checklist a new surface is designed against, not a retrofit. `/writing-for-agents` and CLI authorship reference this ADR and the [doctrine doc](../contexts/dev/axi-toon-doctrine.md).
- **Existing surfaces converge incrementally.** `monitor` → `dashboard` → `daily-review` → `statusline`, one measured slice at a time (first = #918). No big-bang rewrite; no surface is blocked on the others.
- **Output shrinks at the source, not only at the proxy.** RTK stays the safety net for output RedSkills does not control (raw `git`, `gh`, `vitest`, `tsc`); AXI removes the need for it on RedSkills' own CLIs. The two do not conflict — a TOON-emitting monitor piped through RTK simply has less left to compress. *(superseded by Amendment 1 — RTK is retired by ADR 0095; the `rsp` elision layer covers output RedSkills does not control)*
- **Fewer round-trips.** Pre-computed aggregates, definitive empty states, and contextual next-step suggestions each remove a follow-up call the agent would otherwise make — a saving larger than the byte-level TOON win on interactive flows.
- **The 40% claim is verified, not inherited.** The measurement plan (Decision 4) means the doctrine reports real deltas on real payloads; if a surface underperforms the expectation, that is data about the surface, not a reason to abandon TOON.
- **A `--json` / `--full` escape hatch is preserved everywhere.** Agents or tools that need raw JSON or untruncated content keep it; TOON and minimal schemas are the *default*, not a cage.

## Related

- PRD #907 — the parent program that scopes AXI + TOON adoption (Track 1C/F); this ADR is its design-time decision record.
- Issue #918 — the first application slice (`monitor` → TOON).
- [AXI + TOON doctrine doc](../contexts/dev/axi-toon-doctrine.md) — the CLI-author-facing checklist, TOON line-format rules, and the TOON-vs-JSON-vs-prose contrast table that this ADR mandates.
- ADR 0065 — AFK WorkerVitals canonical vocabulary; the `monitor`/`statusline` fields this doctrine serializes read that vocabulary, so minimal-schema selection draws from it.
- ADR 0053 — provider-tidy is report-only governance; a sibling "measure before you assert" posture (report the delta, do not claim it).
- `RTK.md` (global) — the after-the-fact compression proxy whose empirical win motivates the design-time spec; AXI is the upstream complement, not a replacement.

## Notes

- **Doctrine, not lint.** This ADR sets targets and an adoption order. It deliberately does not add a CI gate that rejects a CLI for missing a principle — that would freeze incremental adoption. Enforcement, if ever added, is a later amendment with its own ADR.
- **TOON scope is tabular.** The single most common misapplication is TOON-ing a lone scalar or a one-off nested object where it saves nothing and reads worse. Decision 2 states the boundary as a rule so it survives paraphrase.
- **No source-repo names.** The AXI principle set and the absorbed design philosophy are recorded here as the RedSkills doctrine; their external origin lives in the PRD #907 program history and the grilling session, not in committed naming. TOON is referenced by its public specification (<https://toonformat.dev/>), which is a format standard, not an absorbed source repo.

## Amendment 1 (2026-07-09) — RTK retired; TOON scope widened to all structured data

Two points of the original decision fell to new evidence gathered in the 2026-07-09 grilling session. Everything else above stands.

### 1. RTK is retired — the "safety net" premise no longer holds

The original Consequences kept RTK as the permanent after-the-fact net for output RedSkills does not control ("The two do not conflict"). Local telemetry and the upstream issue tracker broke that premise:

- **The savings are concentrated; the tail is pure cost.** Over 325,137 locally recorded commands, virtually all real saving came from a handful of parsers (`cargo test` 74.5% / 14.3M tokens, `git commit` 91.1%, `ls` 58.3%). The single most-intercepted command — `grep -q`, 91,735 calls — saved 0.0% and produced 91,735 parse failures: it is a silent predicate with no output to compress. 187,095 parse failures were recorded in total; 89 never recovered.
- **The filter lies by design and by bug.** By design, `git push`/`git diff` collapse to `ok`, destroying the information the agent acts on. By bug (upstream, open): `git log --stat` silently drops ~36% of commits, `vitest` reports green on non-zero exit, `find` returns empty stdout silently, exit codes are mangled into misleading diagnoses. A filter that misleads is worse than no filter, because the agent cannot know.

**Decision:** RTK's zero-gain tail is disarmed immediately via its own `[hooks] exclude_commands` config (keeping only the few measured high-yield parsers), and RTK is uninstalled entirely once the `rsp` elision layer (ADR 0095) reaches **measured** parity on those parsers. The doctrine's upstream/downstream split survives — AXI designs cheap output at the source; `rsp` handles output we do not control — but the downstream half is now honest by construction: fail-closed rewriting, passthrough by default, and an Elision-handle invariant instead of silent loss.

### 2. TOON covers all structured data, at every depth

Decision 2 bounded TOON to uniform arrays ("do not force TOON onto a single scalar, a one-off nested config object"). That boundary was written against the house dialect of the time, which read poorly outside tables. The dialect is retired: RedSkills now conforms to the public TOON spec v3.2 via the `@toon-format/toon` encoder/decoder (the reversibility contract of ADR 0095 requires `decode`, which only spec conformance provides off the shelf). Under the spec, nested objects render as indentation and scalars as `key: value` — both cheaper than JSON and no harder to read.

**Decision:** the boundary becomes binary — **all structured data is TOON, at every depth (tabular, nested, scalar); free-form prose is never serialized** (prose has no structure to encode). This removes the per-surface judgment call of "is this tabular enough?". The house dialect's extra-spec syntax (bare summary lines, bracketed status tokens as syntax) is folded into spec-legal form: the summary becomes a trailing TOON field, status tokens become plain field values. The `--json` and `--full` escape hatches are unchanged.

**Adoption scope extends to the memory plugin:** the memory CLI converts TOON-first per surface (`recall` first — the highest-frequency agent read — then `context-pack`, `timeline`/`dashboard`, the rest opportunistically), with `--json` continuing to answer byte-identically for existing consumers; the `red-memory` MCP tool responses follow the same doctrine through the same shared serializers, since their reader is the same model. Every converted slice still reports its measured token delta (Decision 4 is unchanged).

## Amendment 2 (2026-07-14) — encoder authority moves to the published @reddb-io/toon; two-regime output contract

Decided in the wayfinder charting + grilling sessions of 2026-07-14 (map #1765, tickets #1767 and #1768). Everything above stands except the two points below.

### 1. The encoder authority is the published `@reddb-io/toon` (spec v3.3 + TOONL)

Amendment 1 bound RedSkills to the public TOON spec **v3.2** via the external `@toon-format/toon` encoder, wrapped by the private workspace package `packages/toon`. That binding is replaced:

- The canonical implementation is the **published `@reddb-io/toon`** from `github:reddb-io/toon` — TOON **v3.3** (100% of the official spec corpus) plus **TOONL v0.1**, dependency-free, with the toon repo as the **sole publisher**. RedSkills stops maintaining any format package.
- `packages/toon` is deleted; the pnpm catalog repoints the unchanged import name to npm; the house helpers `appendSummaryField`/`projectFields` move upstream into the published package's public API; `@toon-format/toon` leaves the catalog.
- The swap is gated by the existing rsp fidelity/round-trip suites — the reversibility contract (ADR 0095) is the acceptance test for the new encoder.

This also extends the doctrine's reach from stdout to disk: ADR 0097 makes TOON/TOONL the on-disk format doctrine on top of this encoder authority.

### 2. The two-regime output contract

Every TOON/TOONL producer obeys:

1. **Default = lossless.** `decode(encode(x)) === x` always; cell safety is the encoder's quoting, never pre-encode mutation of the data.
2. **Explicit opt-in = declared optimization.** Reduction (field projection, row capping, truncation) happens only behind an explicit flag (`--compact` or equivalent) and is declared in-band — the document marks that it was optimized and what was reduced, with recovery in reach (an Elision handle where bytes are stored; re-run without the flag where the output is re-derivable).

Silent lossy normalization on the default path is the forbidden pattern. The escape hatches of the original decision (`--json`, `--full`) are unchanged.

## Amendment 3: recoverable automatic reduction at the RSP command boundary

RSP's completed-command boundary adds a third, explicitly named **automatic**
regime. Ordinary structured output remains complete. Output may cross into a
lossy summary only when deterministic, fixture-pinned size and repetition
thresholds both activate. Before that summary becomes observable, RSP stores
the original stdout bytes and the summary declares every projection or cap,
contains exactly one recovery handle, and points to `rsp show` and `--full`.

This does not redefine the existing **lossless** level: an explicitly lossless
render never projects, caps, or truncates. `--brief` and `--terse` remain named
optimization levels, and `--full` suppresses the automatic regime. Automatic
reduction is therefore recoverable by construction rather than the silent
default-path normalization prohibited above.
