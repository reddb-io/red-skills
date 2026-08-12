# AXI + TOON doctrine — a checklist for agent-facing CLI authors

This is the CLI-author-facing companion to [ADR 0089](../../adr/0089-axi-toon-doctrine-for-agent-facing-clis.md), which is the binding decision. This doc is the practical restatement: a checklist you run against a CLI whose primary reader is an agent, plus the concrete TOON line format and a contrast table showing why TOON beats JSON and prose for that reader.

**AXI = Agent eXperience Interface** — the design-time contract for how a CLI *chooses* to emit output. **TOON = Token-Oriented Object Notation** — the compact serialization that contract mandates for structured data. AXI is the "why is this output big?" spec; output RedSkills does not control flows through the `rsp` elision layer (ADR 0095). The former third-party proxy safety net is retired by ADR 0089 Amendment 1.

## The 10 AXI principles — checklist

Run each item against your CLI's agent-facing output. These are **targets adopted incrementally**, not a lint gate: a surface is scheduled to close a gap, never rejected for one.

- [ ] **1. Token-efficient output** — structured output is TOON at every depth, not JSON (~40% fewer tokens on tables; see the format rules below). Free-form prose is never serialized.
- [ ] **2. Minimal default schemas** — 3–4 fields per list item by default, not 10. Extra fields are opt-in (`--wide`, `--full`), never the default.
- [ ] **3. Content truncation** — large text is truncated with a size hint (`… +2.1kB, --full`) and a `--full` escape hatch; no unbounded blobs.
- [ ] **4. Pre-computed aggregates** — the counts and rollup statuses the agent would otherwise compute with a second call are already on the summary line.
- [ ] **5. Definitive empty states** — an explicit `0 results` with the next command to try, never ambiguous empty output the agent must guess at.
- [ ] **6. Structured errors & exit codes** — mutations are idempotent, errors carry a structured payload, exit codes are meaningful, and there are no interactive prompts in an agent context.
- [ ] **7. Ambient context** — install opt-in session integrations first (SessionStart), then offer an on-demand skill; do not force the agent to discover state.
- [ ] **8. Content first** — running with no arguments shows live data, not help text.
- [ ] **9. Contextual disclosure** — each output ends with a next-step suggestion (`run X to …`) so the agent needs one fewer guess.
- [ ] **10. Consistent way to get help** — a concise per-subcommand reference reachable the same way everywhere.

## TOON format rules

TOON encodes the JSON data model — same objects, arrays, primitives — but declares a uniform array's fields once and streams the row values line by line. Concretely, an agent-facing CLI's TOON output obeys:

1. **One declared schema per uniform array.** Primitive rows stay on one line: a header declares the array length and field order once (`workers[2]{id,issue,state}:`), then one indented line per row. A lossless object-array column may attach child-table rows beneath its parent; the parent schema is still declared once rather than repeated per entity.
2. **Spec conformance, no house dialect.** Output is encoded with the published `@reddb-io/toon` implementation of TOON v4.1, including its lossless array-column extensions — never a hand-rolled variant, because reversibility (ADR 0095) depends on decoding what we emit. Status tokens are plain field values (`ok`, `FAIL`), not bracketed syntax; scalar attributes are `key: value`. A human skims it; a parser is optional.
3. **Summary is a field.** The pre-computed rollup — totals, counts, elapsed time — is emitted as a trailing TOON field, so the agent reads the aggregate without a second call and a conforming decoder still parses the document: `summary: 2 workers · 1 active · 1 merged · 4m12s`.
4. **All structured data, at every depth** (ADR 0089 Amendment 1). Tabular arrays use the header form; nested objects use indentation; scalars use `key: value`. Free-form prose is the one thing never serialized — it has no structure to encode. The old tabular-only boundary is retired.

Worked example — a fleet roster the agent reads every tick:

```toon
workers[2]{id,issue,state}:
  wEW5N,910,active
  wBXI6,943,merged
summary: 2 workers · 1 active · 1 merged · 4m12s
```

The same data as JSON costs the repeated property names (`id`/`issue`/`state`) and brace/quote punctuation on *every* row; TOON pays for them once in the header.

## Contrast — TOON vs JSON vs prose

Why each alternative is inappropriate for agent-facing output:

| Dimension | TOON | JSON | Prose |
| --- | --- | --- | --- |
| Tokens on N rows | Field names once in header, then bare values → ~40% fewer | Field names + braces + quotes repeated every row | Verbose, unbounded, filler words |
| Parse cost for the agent | Read directly; header gives the schema | Must run a JSON parser to act | Must interpret free text, high error rate |
| Ambiguity | Deterministic columns; explicit empty state | Deterministic but heavy | High — "a few workers are running" is unactionable |
| Human-readable without a parser | Yes — printable ASCII, `key: value` | Barely — nested braces obscure the data | Yes, but not machine-actionable |
| Aggregates | Pre-computed in the `summary` field | Absent unless separately computed | Sometimes, inconsistently |
| Best fit | **Agent-facing structured output, at every depth** | `--json` escape hatch for program-to-program consumers | Human narrative, docs, commit messages |

**Rule of thumb:** JSON is right for a program consuming a program; prose is right for a human reading a story; **TOON is right for an agent reading state it must act on.** Agent-facing CLIs default to TOON and keep a `--json` escape hatch for consumers that genuinely need raw JSON.

## Where this applies

Adoption order (ADR 0089, Decision 3), noisiest agent-read surface first: `monitor` (first slice #918) → `dashboard` → `daily-review` → `statusline`. New agent-facing CLIs start AXI-shaped by running this checklist at design time; existing surfaces converge one measured slice at a time, reporting the token delta per slice.
