---
name: ingest
working-mode: interactive
description: Walk a repo (or a subtree) and populate the memory graph from its code and markdown — symbols, files, headings, concepts, and the edges between them. Use when the user says "index this repo", "ingest the codebase into memory", "/memory:ingest …", or when you want recall to know about the project's structure before working in it. Requires `memory init --mode graph` to have run.
---

# memory ingest

Indexes a project tree into the **graph** store with the deterministic
extractors — no LLM calls. Code files (`.ts/.tsx/.js/.jsx/.py/.go/.rs`) become
`file` + `symbol` nodes with `DEFINED_IN` edges; TypeScript/JavaScript files
also become `import` nodes with `IMPORTS` edges for static import and re-export
specifiers. Markdown files become `concept` nodes (one per file, one per h1–h3
heading) with `REFERENCES` edges for every `[[wiki-link]]`, plus a stored doc
chunk for later search. Everything dedupes by content hash, so re-ingesting an
unchanged tree is a no-op.

For changed-file freshness, use `memory refresh`: it stores a per-file content
hash manifest, skips unchanged files, reports added / updated / skipped / stale
graph elements, and supports hook-friendly `--staged` and `--stdin` modes. The
first freshness implementation is hook-only; there is no filesystem watcher.

This is the `EXTRACTED` (deterministic) ingest path only. Conversation/git
(`INFERRED`) ingestion is not part of this surface.

<what-to-do>

**Index the repository tree into the graph store with the deterministic extractors, then relay the file, node, edge, and doc counts so the user knows what was graphed.**

## 1. Require graph mode

See [Memory preconditions](../../references/PRECONDITIONS.md). If memory is not initialized, run `/memory:init`. If `mode` is not `graph`, ingest has nothing to write to; tell the user to re-run `memory init --mode graph`.

## 2. Ingest

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.mjs" ingest <path>
```

`<path>` is the directory to walk (defaults to `.`). Add `--max-files N` to cap
the pass on a large monorepo. `node_modules/`, `dist/`, `.git/`, `.red/`, and
build/coverage output are ignored by default.

## 3. Scope a Large Repo

Before graphing a big tree, scope the pass. The CLI always prints the
**candidate-file count** before processing so you know what you're about to
index. Narrow it with `--scope`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.mjs" ingest <path> --scope core
```

| `--scope`         | What it graphs                                                        |
| ----------------- | -------------------------------------------------------------------- |
| `proceed`         | every candidate (the default)                                        |
| `core`            | core/app source only — skips tests, examples, vendored & lib trees   |
| `libs`            | shared library/package code only — skips app trees, tests & examples |
| `generate-ignore` | writes a committed `.memoryignore` and stops (no ingest this run)     |

`--scope generate-ignore` writes a **`.memoryignore`** at the repo root — a
committed, human-editable, gitignore-style list of fast-glob patterns (one per
line, `#` comments allowed). Commit it so the whole team shares the same graph
scope. Every later `memory ingest` / `memory refresh` honours it automatically,
with no re-prompt. Hand-edit it any time to add or remove patterns.

## 4. Refresh Changed Files

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.mjs" refresh <file...> --root .
node "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.mjs" refresh --staged --root .
git diff --cached --name-only -z | node "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.mjs" refresh --stdin --root .
```

Use `refresh` after small edits or from git hooks. It is graph-mode only and
does not require a daemon.

## 5. Report

The CLI prints the file / node / edge / doc counts. Relay them so the user knows
what was indexed. For refresh, also relay added / updated / skipped / stale
graph element counts. Then use `/memory:recall` to read the graph back.

## DOs / DON'Ts

- ✅ Ingest after `memory init --mode graph` so recall has structure to search.
- ✅ Re-run ingest after large refactors — dedupe makes it cheap and keeps the graph current.
- ✅ Use `memory refresh --staged` or `--stdin` from git hooks for daemon-free freshness.
- ❌ Don't run ingest in markdown-only mode — there is no graph to populate.
- ❌ Don't expect call/type graphs yet — this slice extracts symbols, TS/JS imports, and markdown structure only.

</what-to-do>
