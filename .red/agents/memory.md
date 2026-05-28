# Memory

How agent auto-memory is stored in this repo.

## Layout

Auto-memory is versioned in-repo so governance rules (English-only,
label naming, AFK stall semantics, workflow-prefix rule) ship with the
clone instead of living per-machine under `~/.claude/`:

```
.red/memory/
├── MEMORY.md              ← index of all stored facts (one line per fact)
└── memory/
    ├── feedback_<slug>.md ← per-fact files (one file per memory entry)
    ├── project_<slug>.md
    ├── reference_<slug>.md
    └── user_<slug>.md
```

`MEMORY.md` links to each per-fact file via the relative path
`memory/<slug>.md`. The per-fact files carry frontmatter (`name`,
`description`, `metadata.type`) and a short body, following the
auto-memory format the harness already expects.

## Harness symlink

The Claude Code system-prompt loader reads memory from
`~/.claude/projects/<project-slug>/memory/`. After migration, that
path is a **symlink** to `<repo>/.red/memory/`, so the loader keeps
resolving the same content without harness changes. `<project-slug>`
is the absolute repo path with `/` replaced by `-` (e.g.
`-home-cyber-Work-reddb-io-red-skills`).

## Migrating from the legacy harness layout

Run once per clone:

```bash
scripts/memory-migrate-from-harness.sh
```

The script is idempotent — re-running on an already-migrated repo
prints `already migrated, no-op` and changes nothing. It also handles
the fresh-clone case: when `.red/memory/MEMORY.md` already exists
in-repo but the harness still has a real directory (a contributor who
just cloned), the script installs the symlink without overwriting the
in-repo content.

Optional flags (rarely needed; defaults are correct for the standard
Claude Code layout):

- `--harness-root <path>` — default `$HOME/.claude/projects`
- `--repo-root <path>` — default `git rev-parse --show-toplevel`
- `--project-slug <slug>` — default derived from the repo path

## Adding a new memory fact

1. Create `<repo>/.red/memory/memory/<type>_<slug>.md` with the
   standard frontmatter (`name`, `description`, `metadata.type`) and
   the body shape required by the type (`feedback` / `project` /
   `reference` / `user`).
2. Add one line to `.red/memory/MEMORY.md` linking to the new file:
   `- [Title](memory/<type>_<slug>.md) — one-line hook`.
3. Commit both files in the same change so the index never drifts.

The harness symlink means the loader picks up new facts immediately
on the next session — no harness reload required.

## Audit-marker contract

An **audit marker** proves that `memory ingest` ran against a specific
commit SHA. It is the prerequisite for the CI drift guard (#224). Two
forms are recognised — **either one** satisfies the contract:

1. **Commit trailer** in a commit message:
   - `Memory-Ingested: <ingest-sha>` — the tree at `<ingest-sha>` was
     ingested into the graph.
   - `Memory-NoIngest: <reason>` — explicit bypass for commits that do
     not need an ingest (typos, formatting-only edits). The `<reason>`
     must be non-empty.
2. **Audit-log entry** of the shape `<iso8601> ingest <path> <ingest-sha>`
   (space-delimited, four fields).

`<ingest-sha>` is a 7–40 char lowercase-hex git object name; `<iso8601>`
is a full ISO-8601 instant with `Z` or a numeric offset.

### Surface decision: **commit-trailer only**

RedSkills ships the **commit-trailer** form as the written surface. We do
**not** track an on-disk audit log. The trailer is git-native and
bisectable, needs no `.gitignore` exception, and avoids a mutating
tracked file that would contradict the operational-state framing of the
graph store below. Accordingly:

- `memory ingest` does not write a file. After a successful ingest it
  **emits guidance** — a ready-to-paste `Memory-Ingested: <HEAD-sha>`
  trailer (or a `<ingest-sha>` placeholder when HEAD is unknown), plus a
  note about the `Memory-NoIngest:` bypass.
- The parser in `plugins/memory/src/audit-marker.ts` (`parseAuditMarker`)
  recognises **both** forms and rejects malformed input with a clear
  error, so a project that chooses to maintain an on-disk audit log is
  still supported by the same parser — only the *written* surface is
  fixed to the trailer.

The drift guard #224 consumes the trailer form (parse `git log` trailers
for `Memory-Ingested:` / `Memory-NoIngest:`).

## PostToolUse watched paths (closed loop)

The Memory plugin's `PostToolUse` hook does **not** re-index every file the
agent edits. It is path-scoped to the closed-loop memory surfaces declared in
**ADR 0027 Amendment**. When an `Edit` / `Write` (Claude) or `apply_patch`
(Codex) touches none of these, `handlePostToolUse` short-circuits to a noop
*before opening the store*; a mixed changed-files list re-indexes the watched
subset only. The skipped invocation is still written to the Memory event log
(ADR 0025) via `recordLifecycle`, so the noop is auditable.

The watched set is the single `WATCHED_GLOBS` constant in
`plugins/memory/src/watched-paths.ts`:

```
.red/adr/**/*.md
.red/wiki/pages/**/*.md
.red/CONTEXT.md
.red/CONTEXT-MAP.md
.red/contexts/**/*.md
```

Adding a new memory surface (e.g. `.red/contracts/**`) is a **one-line change**
to that constant — no handler, matcher, or `.hooks.json` edit is needed. The
`.hooks.json` matchers stay `Edit|Write` (Claude) and `apply_patch` (Codex);
path matching happens on the changed-files payload, not on the matcher string.

## Out of scope

The graph-mode memory store (`.red/memory/graph.rdb*`, `sessions/`,
`.audit.log`, `graph.result-cache.l2*`) is operational state, not
auto-memory. It is gitignored and lives next to (not inside) the
auto-memory layout above. The two surfaces are independent: the
auto-memory index is the human-curated governance store; the graph
is the machine-curated decision store.
