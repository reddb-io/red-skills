---
name: review-adrs
description: Review the `.red/adr/` set for contradictions, missing supersession links, and staleness (paths/commands that moved), cluster the ADRs into a thematic index, and propagate decision changes into the LLM Wiki and Memory graph. Use when asked to "review the ADRs", "are any ADRs conflicting / out of date / superseded", after adding or reversing an ADR, or to group a large ADR set and keep the wiki/memory claims derived from decisions in sync.
---

# Review ADRs (decision-record coherence + propagation)

ADRs accumulate (30–40+ per repo) and **derive**: one reverses another, a path it
cites moves, the wiki and Memory graph hold claims sourced from a decision that
later changed. This is the "doctor of decisions" — sibling to `/doctor` (adoption)
and `memory:doctor` (graph). Lint and grouping are read-only/propositional; any
write (the index, memory supersession, wiki re-ingest) is gated on approval.

<what-to-do>

**Read every `.red/adr/*.md` (and `.red/CONTEXT-MAP.md` / contexts if present). Run the three passes below in order. Detect read-only; only write behind explicit approval.**

### Hard rules

- ❌ Do not edit ADR bodies, rewrite history, or auto-resolve a contradiction. Surface it; the maintainer decides the resolution.
- ❌ Do not delete or hard-edit Memory nodes — use supersession (hide-not-delete), and only after approval.
- ✅ Compose existing surfaces: `/wiki lint` for wiki claims, Memory supersession/contradiction reads for graph claims. Do not reimplement them.
- ✅ Honour ADR conventions in `start/ADR-FORMAT.md` (Status frontmatter, "superseded by ADR-NNNN", Related links).

### Pass 1 — Lint (read-only, detect)

For the ADR set, report:

- **Contradictions** — two ADRs whose decisions oppose on the same topic (e.g. "memory lives in `src/apps`" vs "memory moves to `red-memory`"). Flag pairs that should cross-reference but don't.
- **Missing supersession** — a later ADR reverses/supersedes an earlier one, but the earlier still reads `Status: accepted` with no "superseded by ADR-NNNN" / Related note.
- **Stale references** — an ADR cites a path / file / command that no longer exists (grep the body for paths, check existence; e.g. an ADR naming `src/domains/` after the tree became `src/apps/`).
- **Numbering** — duplicate or gap-colliding ADR numbers (two files claiming the same NNNN, e.g. when parallel branches both grab the next number).

### Pass 2 — Group (the thematic index)

Cluster the ADRs by theme (AFK lifecycle · memory architecture · bundle/fetch · branch-lock · MCP/transport · licensing · repo structure · …). Emit a proposed **`.red/adr/INDEX.md`** — a decision map (the ADR analogue of `CONTEXT-MAP.md`) so a large set is navigable, each entry showing theme, status, and supersession edges. May reuse Memory graph-community clustering when graph mode is available, instead of clustering by hand. *Writing the index is gated on approval.*

### Pass 3 — Propagate to Wiki + Memory (gated)

A changed/superseded ADR leaves derived claims dangling:

- **Wiki** — run `/wiki lint` (contradictions / orphans / stale claims) and find pages whose `REFERENCES` point at the changed ADR → propose a re-ingest of that ADR.
- **Memory** — ADRs are first-class graph nodes (engineering semantic graph). Find nodes whose provenance cites the changed ADR → propose `memory_supersede` on the obsolete claims (reversible hide-not-delete).

Present Pass-3 actions as an approval list; apply only what the maintainer approves.

### Output

A report: lint findings (contradictions / missing-supersession / stale / numbering) with the ADR pairs, the proposed thematic clustering, and the gated propagation actions for wiki + memory. End with the highest-impact decision to reconcile first.

</what-to-do>

<supporting-info>

### Why each pass exists (worked examples)

- **Contradiction / missing supersession:** ADR 0034 placed memory under `src/apps`; ADR 0041 moves it out to the `red-memory` repo — 0034 should carry a "partially superseded by 0041" note. ADR 0032 → superseded by 0034.
- **Stale reference:** an ADR whose body says `src/domains/{dev,memory}` after the tree became `src/apps/` is out of date even though the *decision* still stands — flag the prose, not the decision.
- **Numbering collision:** two PRs each grabbed "next = 0038" (one merged as the afk-bundle-fetch ADR; a second was authored locally and had to renumber to 0039). The lint catches duplicate NNNN before they both land.

### Composition map

| Pass | Reuses |
|---|---|
| 1 Lint | filesystem reads + `start/ADR-FORMAT.md` conventions; Memory contradiction reads when graph mode is on |
| 2 Group | Memory graph communities (optional) for clustering |
| 3 Propagate | `/wiki lint` + `/wiki ingest`; `memory_supersede` / Memory provenance reads |

### Boundaries

- The skill **proposes** supersession and re-ingest; the maintainer approves. Never silently rewrites a decision, the wiki, or the graph.
- Pairs with `/doctor` (adoption/process) and `memory:doctor` (graph health) — three read-only-first doctors over different axes; this one owns **the decision record**.

</supporting-info>
