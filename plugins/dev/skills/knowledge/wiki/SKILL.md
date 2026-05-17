---
name: wiki
description: Operate the LLM Wiki — ingest a source (URL or file), query the wiki and optionally file the answer back as a page, or lint for contradictions/orphans/stale claims. Requires `/wiki-init` to have run. Routes by natural language ("ingest <url>", "query <question>", "lint") or by the verb at the start of the user's request.
---

# wiki

Operate on the LLM Wiki configured by `/wiki-init`. **Always** read `.red/agents/wiki.md` before acting — that file is the source of truth for this repo's conventions.

## Preconditions

- `.red/wiki/` exists.
- `.red/agents/wiki.md` exists.
- `.red/wiki/` is in `.gitignore` (verify before any operation that writes).

If any of those fails, stop and tell the user to run `/wiki-init`.

## Routing

Detect the operation from the verb at the start of the user's message:

- "ingest …" / "ingest <url>" / "add source …" → **Ingest**
- "query: …" / "what / how / why / who / when / where …" / any free-form question → **Query**
- "lint" / "health check" / "audit the wiki" → **Lint**

If ambiguous: ask which operation explicitly.

## Ingest

### 1. Resolve the input

- **URL** → `WebFetch` the content, slugify the title (kebab-case), save to `.red/wiki/raw/<slug>.md` with a minimal YAML header (`url:`, `fetched:`, `title:`). Linked images: download to `.red/wiki/raw/assets/<slug>-<n>.<ext>` and rewrite the refs.
- **Local path (PDF)** → `pdftotext <pdf> .red/wiki/raw/<slug>.txt` (or similar), then normalise to md at `raw/<slug>.md`. Keep the original PDF alongside.
- **Local path (md/txt)** → copy/move to `raw/<slug>.md` if it isn't already there.

### 2. Read and discuss

`Read` the source. Before writing pages, discuss the 3–5 main takeaways with the user. Ask about emphasis: "highlight X or Y more?".

### 3. Write pages

Use the templates in [../wiki-init/](../wiki-init/):

1. **Source page** — `pages/<slug>.md`, `type: source`. Bullets, key claims, quotes, "touches" filled in at the end.
2. **Entity pages** — one for each new person/place/object. Slug kebab-case. If a page already exists, **update** it: add to `sources:`, revise `Overview`, update `updated:`, add new facts.
3. **Concept pages** — same approach.
4. **Contradictions** — if a claim conflicts with an existing page, **do not silence it**. Add a `## Contradictions` section on the affected page citing both sides.

### 4. Update index.md

Add or update entries in the right sections. Alphabetical order within each section. Each entry: `[Title](./pages/slug.md) — one-liner. N sources.`

### 5. Log

Append to `.red/wiki/log.md`:

```markdown
## [YYYY-MM-DD] ingest | <Source title>
- source: raw/<slug>.md
- touched: pages/a.md, pages/b.md, pages/c.md
- notes: <one line on the most important change>
```

### 6. Verify gitignore

Before finishing: confirm `.red/wiki/` is still in `.gitignore`. If it was removed, alert and re-add.

## Query

### 1. Map

`Read` `.red/wiki/index.md`. Identify candidate pages by title and one-liner. If nothing matches, fall back to `grep -ri "<term>" .red/wiki/pages/` or `ripgrep`.

### 2. Drill

`Read` the candidate pages. Follow cross-links if a page cites another relevant one.

### 3. Synthesise

Pick the most useful output format:

- **Markdown prose** — for open-ended questions.
- **Markdown table** — for comparisons or structured lists.
- **Mermaid diagram** — for relationships, timelines, flows.

Other formats (slides, charts) — only on explicit request. The agent can improvise but it's not the default.

Every answer cites the pages (and via them the sources) used. Format: `(via [page-x](./pages/page-x.md))`.

### 4. File back?

If the answer has durable value (a fresh analysis, a non-obvious comparison, a timeline), ask: "file as a `synthesis` page?" If yes:

1. Create `pages/<slug>.md` with `type: synthesis` and the appropriate template.
2. Update `index.md`.
3. Append log: `## [date] query | "<question>" → answer-filed: pages/<slug>.md`.

If it isn't worth a page, just append to the log: `## [date] query | "<question>"`.

## Lint

Runs checks against `.red/wiki/`. **Does not auto-fix** — reports and asks what to do.

### Checks

1. **Contradictions** — scan pages; flag pairs that assert conflicting things. Look for: negations ("X is Y" in one, "X is not Y" in another); different numbers for the same attribute; conflicting dates.

2. **Stale** — pages whose `updated:` is >90 days old and whose referenced `sources:` have `created:` more recent than the page's `updated:` (or whose sources have been superseded by newer sources on the same topic via tags).

3. **Orphans** — pages with no inbound link (`grep -l "./<slug>.md" .red/wiki/pages/` returns empty).

4. **Stubs** — pages with `< 10` lines of content (after the frontmatter).

5. **Missing concepts** — terms repeated `>= 5x` across pages but lacking a page of their own (heuristic: lowercase + frequent bigrams/trigrams).

6. **Gaps** — questions in "Open questions" unresolved for `>60` days.

### Output

Markdown report grouped by the checks above. For each item:

- Path of the affected page(s).
- Detail (e.g. "claim X in pages/a.md vs claim Y in pages/b.md").
- Suggested action (e.g. "consolidate into pages/a.md, cite both sources").

Append to log: `## [date] lint — orphans: N, stale: N, contradictions: N, stubs: N, gaps: N`.

## Anti-patterns

- ❌ Do **not** operate without reading `.red/agents/wiki.md` first.
- ❌ Do **not** edit `raw/`. It's immutable.
- ❌ Do **not** silence contradictions — surface them.
- ❌ Do **not** create wikilinks `[[...]]`. Use standard markdown `[...](./...)`.
- ❌ Do **not** commit `.red/wiki/`. Verify `.gitignore` before any `git add`.

## References

- [LLM Wiki — Karpathy gist](./REFERENCES.md#karpathy-llm-wiki) — origin of the pattern.
- [Memex — Vannevar Bush, 1945](./REFERENCES.md#memex) — proto-LLM-wiki.
- [Tolkien Gateway](./REFERENCES.md#tolkien-gateway) — example of incremental human wiki.
- [qmd](./REFERENCES.md#qmd) — local search engine for md, optional.
- [Obsidian Dataview](./REFERENCES.md#obsidian-dataview) — dynamic queries via frontmatter.
