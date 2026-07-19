# References

Background material for the LLM Wiki pattern and adjacent tooling.

## Karpathy — LLM Wiki

- **Source:** https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
- **Author:** Andrej Karpathy
- **Year:** 2026
- **TL;DR:** Instead of RAG (re-deriving knowledge on every query), the LLM **maintains** an incremental markdown wiki. Every new source is absorbed into the existing pages; cross-references, contradictions, and syntheses get compiled. The human curates; the LLM does bookkeeping.
- **Why it matters:** the central pattern of this bucket. The design of `wiki-init` and `wiki` derives from it.

## Memex

- **Source:** Bush, Vannevar — _As We May Think_, The Atlantic, July 1945. https://www.theatlantic.com/magazine/archive/1945/07/as-we-may-think/303881/
- **TL;DR:** Vision of a personal device that stores books, records, and communications, with **associative trails** between documents. The trail is as valuable as the document itself.
- **Why it matters:** proto-LLM-wiki. The piece Bush couldn't solve — who maintains the trail — is exactly what an LLM solves.

## Tolkien Gateway

- **Source:** https://tolkiengateway.net/wiki/Main_Page
- **TL;DR:** Fan wiki of Tolkien's legendarium. Thousands of cross-linked pages (characters, places, languages, events) built by volunteers over many years.
- **Why it matters:** concrete example of an incremental human wiki. Demonstrates what an LLM can build on its own with light supervision.

## qmd

- **Source:** https://github.com/tobi/qmd
- **Author:** Tobias Lütke
- **TL;DR:** Local search engine for markdown. BM25 + vector search + LLM re-ranking, fully on-device. CLI + MCP server.
- **When to install:** once the wiki grows past ~300 pages and `grep`/`ripgrep` becomes a query bottleneck. Update the search section in the consumer repo's `.red/agents/wiki.md` to point at `qmd`.

## Obsidian Dataview

- **Source:** https://github.com/blacksmithgu/obsidian-dataview
- **TL;DR:** Obsidian plugin that runs SQL-like queries over page YAML frontmatter. Enables dynamic tables, lists filtered by tag/type, and charts.
- **Why it matters:** enables rich views over the wiki without changing files — useful for a dynamic `index.md` during interactive use. We keep `index.md` static in the canonical format (so GitHub renders it), but the user can add local Dataview blocks without breaking portability.

## Obsidian Web Clipper

- **Source:** https://obsidian.md/clipper
- **TL;DR:** Browser extension that converts web articles into markdown and saves them into the vault.
- **Why it matters:** a quick shortcut to feed `.red/wiki/raw/`. An alternative to the `/wiki ingest <url>` flow when the content sits behind a paywall or requires login.

## Adjacent patterns

- **Zettelkasten** (Niklas Luhmann) — slip-box method with atomic notes and links. Difference: Zettelkasten has the human writing atomic notes; LLM Wiki has the agent writing integrated pages.
- **Personal Knowledge Graphs** — same idea expressed as a graph (Roam, Logseq). LLM Wiki is the markdown-plus-frontmatter variant.
- **NotebookLM, ChatGPT file uploads** — antagonists: RAG without persistence. Every query re-derives.
