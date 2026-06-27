# OpenCode skills are the same `SKILL.md` files Claude/Codex already publish — flat-symlinked, name-validated, never rewritten

## Status

accepted. Refines ADR 0075 (Slice 2 of the opencode-host plan). The Slice 1
contract — `apps/opencode-host/` is the single producer of opencode-native
config — is unchanged; this ADR adds the **skills** surface to the
generator.

## Context

The Slice 1 decision (ADR 0075) covered only the `provider>` block. The
remaining gap for "opencode as a third host" is **discoverability**: a user
running `opencode .` on a reddb.io repo should see the same 47 skills
Claude Code and Codex already see, with the same `<what-to-do>` body
intact, with the same `name:`/`description:` frontmatter opencode's
built-in `skill` tool consumes.

Two naive approaches were considered and rejected:

1. **Generate opencode `tool({ description, args, execute })` per skill**
   (the original Slice 2 sketch in the `to-issues` plan). The execution
   body of every RedSkills skill is `node $PLUGIN_ROOT/.../afk.mjs <cmd>`,
   a long-lived launcher invocation, not a synchronous function
   returning a string — the `tool` shape is a poor fit. The shape also
   forces the generator to author a 4-6 KB TypeScript file per skill,
   drifting the source of truth away from `SKILL.md` and breaking
   ADR 0034 (definitions vs. implementation).
2. **Rewrite the body** to fit opencode's `description` budget (1024
   characters) and inline Zod args. The current SKILL.md bodies are
   intentionally rich — 669 lines for `afk`, 149 for `triage` — and
   trimming them to a description-flavoured paragraph loses the
   contract surface the agent needs.

OpenCode already has a **native `SKILL.md` discovery** mechanism
(verified against the opencode Agent Skills doc, June 2026):

- Project-local: `.opencode/skills/<name>/SKILL.md`,
  `.claude/skills/<name>/SKILL.md`, `.agents/skills/<name>/SKILL.md`.
- The `name` frontmatter must match the directory name, be 1-64 chars,
  lowercase alphanumeric with single-hyphen separators, regex
  `^[a-z0-9]+(-[a-z0-9]+)*$`.
- The `description` frontmatter is 1-1024 chars and is the text the
  built-in `skill` tool surfaces to the agent for selection.

Every RedSkills `SKILL.md` already has the required `name:` and
`description:` frontmatter (e.g. `afk/SKILL.md` has `name: afk`,
`description: Autonomous loop that drains…` — single-line, well under
1024 chars). The bodies follow the project's XML `<what-to-do>` /
`<supporting-info>` convention (CLAUDE.md §SKILL.md body convention)
which is orthogonal to opencode's body expectations — opencode loads
the whole `SKILL.md` and renders it on `skill({ name })` invocation, so
the body shape is preserved as-is.

## Decision

### 1. The generator emits `dist/opencode/<plugin>/.opencode/skills/<name>/SKILL.md`

For every `SKILL.md` under
`plugins/<plugin>/skills/<bucket>/<name>/SKILL.md`, the generator writes
a **flat, single-level** symlink (preferred) or copy to
`dist/opencode/<plugin>/.opencode/skills/<name>/SKILL.md`. The
`<bucket>/` layer (`engineering/`, `knowledge/`, `productivity/`,
`misc/`, `in-progress/`) is a RedSkills organisation concern; opencode
treats `name` as the sole namespace, so the bucket is dropped. The
symlink target is the original `SKILL.md` — **never rewritten**.

- **`in-progress/` is skipped.** Slices 1-5 ship the curated skill set
  only; `in-progress/` is a draft area (per CLAUDE.md §Structure rule
  1: "Skills in `in-progress/` appear in neither") and the Slice 2
  generator respects that rule by exclusion.
- **Name validation is fail-closed.** A skill whose directory name
  violates opencode's regex (1-64 chars, lowercase alphanumeric with
  single-hyphen separators, no leading/trailing/consecutive hyphens)
  is logged as an error and the generator returns non-zero. Renaming
  the skill directory is the fix — the adapter does **not** rename
  on the user's behalf (a renamed symlink would silently drift from
  the Claude/Codex surface and break parity with ADR 0034).
- **Frontmatter `name` ↔ directory match is enforced.** opencode will
  refuse to load a skill whose frontmatter `name:` does not match its
  directory name; the generator surfaces the mismatch as a build
  error so the divergence is caught at `generate` time, not at opencode
  TUI startup.

### 2. The dist output is what the user installs, not the source

`dist/opencode/<plugin>/` is a self-contained tree with everything
opencode needs:

```
dist/opencode/<plugin>/
├── opencode.json               ← Slice 1 (provider block + model)
├── .opencode/
│   ├── plugin/<name>.ts        ← Slice 2 (hook → event module)
│   └── skills/<name>/SKILL.md  ← Slice 2 (this ADR)
```

A user installs the plugin by pointing opencode at the dist root via
`opencode.json` `plugin: [...]` or by `cp -r dist/opencode/<plugin>/
.opencode/` into their repo. The Slice 1 bundled form
(`dist/opencode-host.bundle.min.mjs`) is the build-time tool; the
`dist/opencode/<plugin>/` tree is the **runtime artefact** opencode
loads. They are distinct outputs from the same `apps/opencode-host/`
package.

### 3. Symlink vs copy is a build-time decision

Default: **symlink**, with a fallback to copy when the platform does
not support symlinks (Windows without admin, some CI sandboxes). The
symlink target is a relative path (`../../../../plugins/<plugin>/skills/
<bucket>/<name>/SKILL.md`), so a `git clone` of the dist tree resolves
back to the red-skills checkout. The `--copy` flag forces the copy
path; the default is recorded in `dist/opencode/<plugin>/INSTALL.md`
for the install command the user runs.

Symlinking is preferred because it preserves the single-source-of-truth
property (ADR 0034): an edit to the source `SKILL.md` is visible to
opencode on the next session, no rebuild step. Copy is the safe path
when the user runs the dist tree from a different filesystem where the
relative target would not resolve.

### 4. `argument-hint:` is preserved in the symlinked body

The `argument-hint:` frontmatter field used by some RedSkills skills
(e.g. `afk`, `ship`) is not in opencode's recognised frontmatter set
(only `name`, `description`, `license`, `compatibility`, `metadata`
are). OpenCode silently ignores unknown fields, so the field is kept
in the symlinked body and the agent surfaces the slash-completion
hint through opencode's own prompt-completion path. This is the same
"ignore unknown frontmatter" semantics as Claude Code and Codex
exhibit.

### 5. The skills-to-opencode module is pure

`apps/opencode-host/src/skills-to-opencode.ts` exports a single
`planSkillSymlinks(pluginsRoot, outRoot): SkillPlan[]` function. The
function reads the `plugins/<plugin>/skills/<bucket>/<name>/SKILL.md`
tree, validates names, and returns a list of `(source, target,
name)` triples. The actual file system writes happen in
`emit.ts` (Slice 2 orchestration), keeping the planning step pure
and unit-testable with no `fs` mocking.

## Considered options

- **Re-author each skill as an opencode `tool({ description, execute
  })`** — rejected: a 669-line `afk` skill body is not a synchronous
  tool body; the canonical command surface is a 4.9 KB launcher binary
  invoked by the LLM. Forcing the skill into a `tool` shape either
  loses the body (description-only — useless for the agent) or
  inlines the launcher invocation into a 4-6 KB TypeScript file per
  skill, drifting away from `SKILL.md` and breaking the defs-vs-impl
  split (ADR 0034).
- **Generate a single bundled `tool` that delegates by name** —
  rejected: same body-loss problem; also a 1-arg `tool` that branches
  on `name` is harder to audit than 47 distinct skill directories.
- **Use opencode's Claude-compatible discovery path
  (`.claude/skills/<name>/SKILL.md`)** instead of `.opencode/...` —
  rejected as the **default**, accepted as a **fallback**. The
  `.opencode/skills/` path is the host-native one; emitting to
  `.claude/` would couple the opencode-host adapter to the Claude
  layout, which is exactly the cross-host coupling ADR 0034 says
  to avoid. The default is `.opencode/`. A `--claude-skills-dir`
  flag emits to `.claude/skills/` for users who mix hosts in the
  same checkout and want a single source of skill discovery.

## Consequences

- A user running `opencode .` on a reddb.io repo sees the full
  curated skill set (40 skills today; the 7 in `in-progress/` are
  skipped per the existing rule) without any per-skill config or
  rebuild step.
- A skill edit is visible on the next opencode session, no rebuild
  required (symlink default). The copy path is a fallback for
  environments where the symlink target would not resolve.
- A skill whose directory name violates opencode's regex is a
  **build error**, not a silent skip. The agent never sees a
  partial skill set; the user gets a clear `name: "Foo_Bar" is not
  lowercase-hyphen-separated` error pointing at the offending
  directory and the rule it violates.
- A skill whose frontmatter `name:` does not match its directory
  is a **build error**. The mismatch would be caught by opencode
  at TUI startup with a worse error message; catching it at
  `generate` time puts the diagnostic next to the file the user
  edits.
- The skills-to-opencode module is pure; tests do not touch the
  filesystem. The emit orchestration is a thin shell loop and is
  smoke-tested in the CLI suite alongside the Slice 1 cases.
- The Slice 1 dist tree is unchanged: `dist/opencode/<plugin>/
  opencode.json` continues to ship as the provider-block artefact.
  Slice 2 adds the `.opencode/skills/...` subtree under the same
  root.
- A user who wants the full slice (provider + skills + hooks) runs
  the same `generate` command as Slice 1 and gets both outputs. No
  new flag is required; the generator's per-plugin mode (`generate
  <plugin>`) is the single entrypoint.

## Status

Accepted. Implements the Slice 2 skills surface of the opencode-host
plan. The Slice 1 contract (ADR 0075) and the AFK runner contract
(ADR 0059) are unchanged; this ADR adds a new output subtree
(`dist/opencode/<plugin>/.opencode/skills/`) without modifying the
provider block or the bundle shape.

## Related

- **0075** — the Slice 1 decision; introduces the `opencode-host` app
  as the adapter layer. Slice 2 extends it.
- **0067** — per-directory plugin activation gate; the Slice 2
  generator reuses the same `plugins.<plugin>.enabled: true` check
  from Slice 1.
- **0034** — monorepo definitions vs. implementation split; the
  adapter symlinks `SKILL.md` as-is rather than rewriting it, so
  the source-of-truth property is preserved.
- **CLAUDE.md §SKILL.md body convention** — the `<what-to-do>` /
  `<supporting-info>` XML split is preserved in the symlinked body;
  opencode ignores body shape and only consumes the frontmatter
  `name`/`description` for selection.
- **opencode Agent Skills doc** (June 2026) — name validation regex,
  `description` length budget, and the four discovery paths
  (`.opencode/`, `.claude/`, `.agents/`, `~/.config/...`). This ADR
  commits to the `.opencode/` default and supports `.claude/` as a
  fallback via the `--claude-skills-dir` flag.
