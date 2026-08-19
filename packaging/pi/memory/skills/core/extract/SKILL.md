---
name: extract
working-mode: interactive
description: Extract durable facts from a transcript into the Memory graph through the configured AI provider. Use when the user wants to preserve decisions, gotchas, root causes, or reasoning traces from a conversation or log. Graph mode only; requires `provider` in the `plugins.memory` block of `.red/config.yaml`.
---

# memory extract

Turns a transcript into `INFERRED` memory graph facts. This is the LLM-backed write path: it reads a conversation/log from a file or stdin, asks the configured provider to extract durable facts, and upserts nodes/edges into the graph.

<what-to-do>

**Extract durable facts from the transcript into the graph through the configured provider, then verify with a targeted recall — never run this just to summarize.**

## 1. Require graph mode and provider

`extract` needs graph mode and a `provider` block — see [Memory preconditions](../../references/PRECONDITIONS.md). If either is missing, stop and explain; do not silently fall back to markdown notes.

## 2. Select the transcript deliberately

Use a transcript/log that contains durable operational learning: decisions, root causes, gotchas, why-notes, or failed attempts that explain constraints. Do not extract secrets, raw credentials, private personal data, Odysseus-style Personal facts, biographical details, issue-only progress, PR numbers, commit SHAs, or stale task-completion logs. Long-lived human preferences and identity context belong in Brain — see [Brain-vs-Memory boundary](../../../../brain/skills/references/BRAIN_VS_MEMORY.md).

## 3. Run extraction

```bash
# From a file
node "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.mjs" extract <transcript-file>

# Or from stdin
cat <transcript-file> | node "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.mjs" extract
```

The command prints how many `INFERRED` facts and edges were written and which provider mode/egress was used.

## 4. Verify with recall

Run a targeted recall for one or two extracted topics:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.mjs" recall "<topic>"
```

Report whether the new facts are discoverable. If extraction produced nothing, say so plainly and do not invent facts.

## DOs / DON'Ts

- ✅ Prefer concise transcripts with clear decisions and why-notes.
- ✅ Treat extracted facts as `INFERRED`; verify before relying on them later.
- ✅ Use `/memory:store` for a single hand-authored fact; use `extract` for a rich transcript.
- ❌ Do not extract secrets or transient task progress.
- ❌ Do not run extraction just to summarize; it mutates the Memory graph.

</what-to-do>
