# AXI + TOON is the doctrine for every agent-facing CLI

## Status

Accepted. Codifies the AXI ("Agent eXperience Interface") design-time principles and the TOON output format as the RedSkills standard for every CLI whose primary reader is an agent. Implements Track 1C/F of PRD #907; the first application slice is #918.

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

**These are targets, not a lint.** A surface adopts them incrementally, slice by slice, measured (Decision 4). A CLI is not rejected for missing one; it is scheduled to close the gap.

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

**Scope of TOON, stated as a rule so it is not over-applied:**

- **Use TOON for** uniform arrays of objects — the roster, issue list, PR list, DORA rows. This is where the win is largest and retrieval accuracy holds.
- **Do not force TOON onto** a single scalar, a one-off nested config object, or free-form prose. TOON's win is tabular; a lone object gains nothing and reads worse. JSON (or plain text) stays correct there.
- **Human-facing rendering is unaffected.** A CLI may still render a pretty table for a human; the doctrine governs the *agent-facing* serialization path. A `--json` escape hatch stays available for consumers that need raw JSON.

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

- **New agent-facing CLIs start AXI-shaped.** The ten principles are the checklist a new surface is designed against, not a retrofit. `/write-a-skill` and CLI authorship reference this ADR.
- **Existing surfaces converge incrementally.** `monitor` → `dashboard` → `daily-review` → `statusline`, one measured slice at a time (first = #918). No big-bang rewrite; no surface is blocked on the others.
- **Output shrinks at the source, not only at the proxy.** RTK stays the safety net for output RedSkills does not control (raw `git`, `gh`, `vitest`, `tsc`); AXI removes the need for it on RedSkills' own CLIs. The two do not conflict — a TOON-emitting monitor piped through RTK simply has less left to compress.
- **Fewer round-trips.** Pre-computed aggregates, definitive empty states, and contextual next-step suggestions each remove a follow-up call the agent would otherwise make — a saving larger than the byte-level TOON win on interactive flows.
- **The 40% claim is verified, not inherited.** The measurement plan (Decision 4) means the doctrine reports real deltas on real payloads; if a surface underperforms the expectation, that is data about the surface, not a reason to abandon TOON.
- **A `--json` / `--full` escape hatch is preserved everywhere.** Agents or tools that need raw JSON or untruncated content keep it; TOON and minimal schemas are the *default*, not a cage.

## Related

- PRD #907 — the parent program that scopes AXI + TOON adoption (Track 1C/F); this ADR is its design-time decision record.
- Issue #918 — the first application slice (`monitor` → TOON).
- ADR 0065 — AFK WorkerVitals canonical vocabulary; the `monitor`/`statusline` fields this doctrine serializes read that vocabulary, so minimal-schema selection draws from it.
- ADR 0053 — provider-tidy is report-only governance; a sibling "measure before you assert" posture (report the delta, do not claim it).
- `RTK.md` (global) — the after-the-fact compression proxy whose empirical win motivates the design-time spec; AXI is the upstream complement, not a replacement.

## Notes

- **Doctrine, not lint.** This ADR sets targets and an adoption order. It deliberately does not add a CI gate that rejects a CLI for missing a principle — that would freeze incremental adoption. Enforcement, if ever added, is a later amendment with its own ADR.
- **TOON scope is tabular.** The single most common misapplication is TOON-ing a lone scalar or a one-off nested object where it saves nothing and reads worse. Decision 2 states the boundary as a rule so it survives paraphrase.
- **No source-repo names.** The AXI principle set and the absorbed design philosophy are recorded here as the RedSkills doctrine; their external origin lives in the PRD #907 program history and the grilling session, not in committed naming. TOON is referenced by its public specification (<https://toonformat.dev/>), which is a format standard, not an absorbed source repo.
