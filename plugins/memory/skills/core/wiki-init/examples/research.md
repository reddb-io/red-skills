# Example — Research wiki

A research repo covering "LLM Wiki patterns and adjacent tooling".

## After `/wiki-init`

```
.red/wiki/
├── index.md                     # empty, with stub sections
├── log.md                       # header only
├── raw/
│   └── assets/
└── pages/
```

`.red/agents/wiki.md` populated with:
- `{{domain}}` = "research on LLM Wiki patterns and adjacent tooling"
- `{{source-types}}` = "web articles, PDFs (papers), podcast transcripts, personal notes"
- `{{voice}}` = "first person (solo)"

## After 3 ingests

```
.red/wiki/
├── index.md
├── log.md
├── raw/
│   ├── karpathy-llm-wiki.md       # from the gist
│   ├── memex-as-we-may-think.md   # extracted PDF
│   └── qmd-readme.md              # from GitHub
└── pages/
    ├── karpathy-llm-wiki.md       # type: source
    ├── memex-as-we-may-think.md   # type: source
    ├── qmd-readme.md              # type: source
    ├── andrej-karpathy.md         # type: entity
    ├── vannevar-bush.md           # type: entity
    ├── llm-wiki.md                # type: concept
    ├── memex.md                   # type: concept
    ├── associative-trails.md      # type: concept
    ├── rag.md                     # type: concept (contrast with llm-wiki)
    └── wiki-vs-rag.md             # type: synthesis
```

Example `index.md`:

```markdown
# Index

## Sources

- [Karpathy — LLM Wiki gist](./pages/karpathy-llm-wiki.md) — 2026. The incremental LLM-maintained wiki pattern.
- [Bush — As We May Think](./pages/memex-as-we-may-think.md) — 1945. Original Memex vision.
- [qmd README](./pages/qmd-readme.md) — Tobi Lütke. BM25+vector search over local markdown.

## Entities

- [Andrej Karpathy](./pages/andrej-karpathy.md) — author of the gist. 1 source.
- [Vannevar Bush](./pages/vannevar-bush.md) — proto-author of the idea (Memex). 1 source.

## Concepts

- [Associative trails](./pages/associative-trails.md) — links between documents as knowledge in their own right. 2 sources.
- [LLM Wiki](./pages/llm-wiki.md) — the central pattern. 1 source.
- [Memex](./pages/memex.md) — Bush's proto-LLM-wiki. 1 source.
- [RAG](./pages/rag.md) — antagonist to the LLM Wiki: retrieval without synthesis. 1 source.

## Syntheses

- [Wiki vs RAG](./pages/wiki-vs-rag.md) — accumulating vs re-deriving. 3 sources.
```
