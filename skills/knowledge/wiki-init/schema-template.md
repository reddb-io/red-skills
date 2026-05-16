# Wiki — Schema

This document teaches the agent how to maintain this repo's LLM Wiki. It is read every time `/wiki` operates.

## Domain

**What this wiki is about:** {{domain}}

**Accepted source types:** {{source-types}}

**Voice:** {{voice}}

## Layout

```
.red/wiki/
├── raw/                # immutable sources — agent reads, never edits
│   └── assets/         # images downloaded from online sources
├── pages/              # agent-generated pages — flat, kebab-case.md
├── index.md            # catalogue grouped by type
└── log.md              # append-only "## [date] op | title"
```

The entire `.red/wiki/` directory is in `.gitignore`. **Never** commit it. Backup/sync across machines is the user's responsibility (dedicated private repo, syncthing, etc.).

## Page conventions

**Filename:** `kebab-case.md`, canonical slug. The display name comes from the frontmatter `title:`.

**Mandatory frontmatter:**

```yaml
---
title: Frodo Baggins                 # display name
type: entity                         # entity | concept | source | synthesis | comparison
tags: [hobbit, ring-bearer]          # free-form
created: 2026-05-16
updated: 2026-05-16
sources: [fellowship-ch1, prologue]  # slugs in .red/wiki/raw/ or pages/sources/
---
```

**Types:**

- `entity` — person, place, organisation, concrete object.
- `concept` — idea, pattern, theory, method.
- `source` — summary of a single ingested source. Slug matches the file in `raw/`.
- `synthesis` — analysis that crosses multiple sources/entities/concepts. Includes comparisons.
- `comparison` — a particular case of synthesis (use freely).

Can a page be multi-typed? Yes — pick the **dominant** type and use `tags` for secondary dimensions.

**Cross-links:** standard markdown `[Frodo](./frodo-baggins.md)`. No Obsidian wikilinks (keeps GitHub portability).

## index.md

Structure:

```markdown
# Index

## Sources

- [Fellowship Ch.1](./pages/fellowship-ch1.md) — Tolkien, 1954. Bilbo's farewell party.

## Entities

- [Frodo Baggins](./pages/frodo-baggins.md) — hobbit, ring-bearer. 3 sources.
- [The Shire](./pages/the-shire.md) — hobbit homeland. 2 sources.

## Concepts

- [Eucatastrophe](./pages/eucatastrophe.md) — sudden joyous turn (Tolkien). 1 source.

## Syntheses

- [Ring temptation patterns](./pages/ring-temptation-patterns.md) — comparison across bearers. 4 sources.
```

Keep entries alphabetical within each section. Update on every ingest and every query that becomes a page.

## log.md

Append-only. Greppable prefix `## [YYYY-MM-DD] op | title`:

```markdown
# Log

## [2026-05-16] ingest | Fellowship of the Ring, ch.1
- source: raw/fellowship-ch1.md
- touched: pages/frodo-baggins.md, pages/the-shire.md, pages/bilbo-baggins.md, pages/fellowship-ch1.md
- notes: Bilbo's farewell; Ring passed to Frodo.

## [2026-05-16] query | "who knew about the Ring before Frodo?"
- answer-filed: pages/ring-knowledge-pre-frodo.md
- touched: index.md

## [2026-05-17] lint
- orphans: 2 (resolved)
- stale: 0
- contradictions: 1 flagged in pages/aragorn.md
```

Useful command: `grep "^## \[" log.md | tail -5`.

## Operations

### Ingest

Input: a URL or a file path under `.red/wiki/raw/`.

1. If URL: download to `raw/<slug>.md` (WebFetch or similar). Referenced images → `raw/assets/`.
2. If PDF: extract text via `pdftotext` or similar into `raw/<slug>.md` alongside the original PDF.
3. Read the source. Discuss key takeaways with the user before writing.
4. Create `pages/<slug>.md` with `type: source`, a summary, and full frontmatter.
5. Identify new entities/concepts → create pages. Identify existing ones → update them, add to `sources:`, revise the body.
6. Flag contradictions with prior sources — do not silence them. Add a `## Contradictions` section on the affected page when they occur.
7. Update `index.md`.
8. Append an entry to `log.md`.

A single ingest can touch 10–15 pages. Show the diff/list before applying when possible.

### Query

Input: a natural-language question.

1. Read `index.md` first to map candidate pages.
2. `Read` the relevant pages.
3. Synthesise the answer. Supported formats: markdown prose, markdown table, Mermaid diagram. Other formats: ask explicitly.
4. Every answer cites the pages (and via them the sources) used.
5. If the answer has durable value, ask the user whether to file it back as a new page (`type: synthesis` in most cases). If yes → create the page + update index + log.

Substring/concept search: `grep` or `ripgrep` over `pages/`. If the wiki grows past ~300 pages and search becomes painful, install [qmd](https://github.com/tobi/qmd) and update this section.

### Lint

Periodic health check. Looks for:

- **Contradictions** — conflicting claims across pages. Listed by page pair.
- **Stale** — pages whose `updated:` is very old and whose `sources:` have been superseded by newer sources.
- **Orphans** — pages with no inbound links (no other page references them). May indicate isolation or a candidate for removal.
- **Stubs** — short pages (~<10 lines) that warrant expansion.
- **Unpaged concepts** — terms repeated across pages without a page of their own.
- **Gaps** — obvious unanswered questions; suggest sources to fetch.

Reports findings. Does not auto-fix — asks what to do.

Append `## [date] lint` to the log with counts.

## Anti-patterns

- ❌ Do **not** treat the wiki as a spec or changelog. It is knowledge accumulation.
- ❌ Do **not** commit `.red/wiki/`. Check `.gitignore` before any `git add -A`.
- ❌ Do **not** edit files in `raw/`. Sources are immutable.
- ❌ Do **not** create Obsidian wikilinks `[[...]]` — they break outside Obsidian.
- ❌ Do **not** introduce new conventions unilaterally — ask; if agreed, update **this file** immediately to crystallise the decision.
