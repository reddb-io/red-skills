---
name: curate
description: Interactive Skill curator. Reads `memory curate skills --json`, groups Curatable-skill candidates by category (`stale`, `abandoned`, `frequently-failing`, `archive`), asks for explicit approval, archives the approved set recoverably with the approving category recorded in the manifest, and reverses any archive with `/curate --restore <name>`.
argument-hint: "[--restore <skill-name>] (no arg = interactive curation flow)"
---

<what-to-do>

This skill **mutates skills on disk**. Run the loop below verbatim. Every mutation goes through `red-curate-skill`, the workflow engine the Memory plugin exposes — never invent shell commands that delete, overwrite, or rename skill files directly.

### Boot precondition (always, before anything else)

Run `red-curate-skill check`. If it exits non-zero, print its stderr verbatim and **stop**. The error already names the exact `memory init --mode graph --skill-telemetry` command the user needs.

> **Why this exists:** the curator runs on Skill telemetry rollups (Curatable-skill activity counts, archive signals). Without **Graph mode** + the `--skill-telemetry` opt-in, there is no evidence to curate — failing fast is the only safe answer.

### Restore mode — `--restore <name>`

If the argument starts with `--restore`:

1. Extract `<name>` (everything after `--restore`).
2. Run `red-curate-skill restore <name>`.
3. The engine reads the archive manifest, moves the skill back to its **original** path, and verifies every restored file's SHA-256 against the manifest.
4. Print the engine's receipt verbatim. Stop.

If the user passes `--restore` with no name, ask for one and re-issue.

### Curation mode — default (interactive)

1. **List candidates.** Run `red-curate-skill list`. It emits JSON of the form:
   ```json
   {
     "candidates": [...],
     "byCategory": { "stale": [...], "abandoned": [...], "frequently-failing": [...], "archive": [...] },
     "filtered": [...],
     "totals": {...}
   }
   ```
   `candidates[]` is the flat list across every in-scope category; each entry carries `category` and the curator's `reason` for that category. `byCategory` is the same data indexed by category — **categories with zero candidates are absent**, never present as empty arrays. `filtered[]` records anything the engine defensively dropped (bundled `plugin`/`hub` source kinds, pinned skills, non-curatable items).

2. **Empty case.** If `candidates` is `[]` (equivalently, `byCategory` is `{}`), print `no curate candidates — nothing to curate` and **stop**. Do not invoke `archive`. Do not write any file.

3. **Show the user, grouped by category.** For each category present in `byCategory`, in the order `stale`, `abandoned`, `frequently-failing`, `archive`, print a header naming the category and one block per candidate beneath it. Each block must show:
   - the skill `name`,
   - `source_kind`,
   - the original `path`,
   - the category-specific evidence carried in `reason` (e.g. "no skill activity for 90d (threshold 60d)" for `stale`, "loaded 5× but never invoked" for `abandoned`, "3/6 results failed (50%)" for `frequently-failing`, the archive signal text for `archive`).

   **Do not** render a header for a category that is not present in `byCategory`. Use the canonical glossary terms — "Curatable skill", "Skill telemetry", and the four category names — verbatim.

4. **Ask for explicit approval.** Prompt: `Archive which skills? Reply with comma-separated names, "all", or "none".` Approval is by skill name; if the same skill appears in more than one category, ask the user which category to record before archiving and archive once. Treat anything that isn't a known candidate name (or `all`) as `none`. **No approval = no mutation.** This is the load-bearing safety surface; do not infer consent from silence, conversation history, or default.

5. **Archive each approved Curatable skill.** For every approved name, invoke `red-curate-skill archive --candidate <json>` where `<json>` is the matching candidate object from step 1 (including its `category`) emitted via single-quoted JSON. The engine:
   - Re-validates `source_kind` and `pinned` (refuses bundled / pinned inputs with a structured rejection — no I/O).
   - Computes SHA-256 + byte length for every file under the skill's directory.
   - Moves the skill into `.red/memory/skill-archive/<name>/payload/` via atomic `rename` (no `unlink`/`rm`).
   - Writes a manifest at `.red/memory/skill-archive/<name>/manifest.json` recording the original root, archive timestamp, **the approving category**, the evidence reason, and per-file hashes.

6. **Print the receipt.** For each archived skill, echo the engine's one-line output. Then print: `Restore any of them with /curate --restore <name>.`

### Invariants you must not violate

- ✅ Empty / declined approval → zero filesystem mutations.
- ✅ Bundled (`source_kind` `plugin` / `hub`) and pinned skills are filtered defensively in every category and never archived, even if a future Memory build leaks one into the report.
- ✅ Categories with zero candidates are omitted from the listing — never shown as empty headers.
- ✅ Every archive is recoverable through `/curate --restore <name>` — the engine refuses to clobber an existing archive directory and refuses to overwrite a live skill on restore.
- ❌ Never call `rm`, `unlink`, `git rm`, or any shell that deletes files in this flow. The engine uses `rename` only; you must follow the same discipline.

</what-to-do>

<supporting-info>

### Invocation cheat sheet

```
# Boot check (always first)
red-curate-skill check

# List candidates grouped by category as JSON
red-curate-skill list

# Archive one approved candidate (category flows into the manifest)
red-curate-skill archive --candidate '{"name":"foo","source_kind":"project","path":"/abs/.../SKILL.md","reason":"no skill activity for 90d (threshold 60d)","category":"stale"}'

# Restore one archived skill
red-curate-skill restore foo
```

The CLI ships as part of `@reddb/memory` (see `plugins/memory/src/curate-skill/cli.ts`). The Memory plugin's own `memory` CLI never invokes archive or restore — the mutation workflow lives in this skill.

### Archive layout

```
.red/memory/skill-archive/
└── <skill-name>/
    ├── manifest.json   # {name, originalRoot, archivedAt, category, reason, files:[{relativePath, sha256, byteLength}]}
    └── payload/        # the renamed-in original skill directory
        ├── SKILL.md
        └── ...
```

After a restore, the `payload/` directory is renamed back to its original path and the `manifest.json` is intentionally left behind as a record (the engine never calls a destructive op).

### Glossary anchors

- **Curatable skill** — a Skill whose files may be modified, consolidated, or archived because it is user-owned or agent-created. Bundled `plugin` / `hub` skills are not Curatable.
- **Skill telemetry** — lifecycle and interaction events for a Skill, available only in **Graph mode** with the `--skill-telemetry` opt-in.
- **stale** — a Skill that has had no activity for at least the configured stale threshold (default 60 days).
- **abandoned** — a Skill that has been viewed (loaded) but never used, or whose `abandoned` outcomes outweigh `succeeded` ones.
- **frequently-failing** — a Skill whose share of `failed` result outcomes is at or above the failure-ratio threshold over a minimum number of result events.
- **archive** — the recoverable move of an approved Curatable skill into `.red/memory/skill-archive/`, reversible via `/curate --restore`.

### Scope (this slice)

This slice extends the tracer's archive-only flow to the four in-scope curator categories: `stale`, `abandoned`, `frequently-failing`, and `archive`. The remaining curator categories (`consolidation`, `restore`) surface in the Memory report but are **not** acted on by this version of `/curate`; their mutating workflows are later slices.

</supporting-info>
