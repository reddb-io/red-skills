# 0078 — OpenCode install path is `scripts/install-opencode.sh` — local + global modes flatten the dist tree to match opencode's loader

## Status

accepted. Refines the Slice 2 install surface (ADR 0076 + 0077) with
the **operational install contract**. The Slice 1 + 2 generator contract
is unchanged; this ADR adds a thin wrapper that does generation +
install in one command, and documents the layout choices that follow
from opencode's loader rules.

## Context

Slice 1 (ADR 0075) and Slice 2 (ADR 0076 + 0077) give the opencode-host
adapter a `dist/opencode/<plugin>/.opencode/{plugin,skills}/` shape.
The generator emits the dist tree; the **install** step — copying it
into a target directory in a shape opencode's loader recognises —
was left as a follow-up. Without it, a user cloning the repo cannot
get to a working `opencode .` session in fewer than four commands
(`pnpm install`, `pnpm build`, `pnpm --filter ... generate --with-slice-2`,
`cp -R dist/opencode/<plugin>/.opencode <target>/`), and the global
install needs the right flatten for opencode's non-recursive global
plugin loader.

Two opencode loader rules drive the install shape (verified against
the opencode Plugins doc, June 2026):

- **Project plugins** — opencode auto-loads every `.ts` / `.js` /
  `.mjs` file directly under `.opencode/plugins/`. It does **not**
  recurse into subdirectories. Skills are loaded from
  `.opencode/skills/<name>/SKILL.md` (flat per skill name).
- **Global plugins** — same non-recursive shape under
  `~/.config/opencode/plugins/`. The global skill loader reads
  `~/.config/opencode/skills/<name>/SKILL.md` (also flat per name).

The dist tree the generator emits, by contrast, is **nested per
plugin** — `dist/opencode/<plugin>/.opencode/{plugin,skills}/`. The
local install copies each plugin's `.opencode/` subtree into a single
shared `<target>/.opencode/` root, and the bucket layer is dropped
(per Slice 2 name-validation: the bucket layer is a RedSkills org
concern; opencode uses `name` as the sole namespace). The global
install flattens further: each plugin module becomes a top-level
file (`redskills-<plugin>-<event>.ts`) and each skill is a single
directory under `~/.config/opencode/skills/<name>/`. The flatten is
lossy by construction — multiple plugins shipping a skill with the
same name is a Slice 2 build error and would have been caught
upstream.

## Decision

### 1. `scripts/install-opencode.sh` is the canonical install entrypoint

A single bash script lives at `scripts/install-opencode.sh` in the
repo root. It does, in order:

1. Verify the preconditions (`.red/config.yaml` with
   `plugins.dev.enabled: true`; `plugins/` tree present).
2. `pnpm install` (first run only).
3. Bundle the generator if `dist/opencode-host.bundle.min.mjs` is
   absent (otherwise prefer the bundle; fall back to `tsx` for the
   local-dev path).
4. Run the generator with `--with-slice-2` and the user's `--config`
   and `--plugins-root` (defaults: `./.red/config.yaml` and
   `./plugins`).
5. Discover the plugins in the dist tree and install them into the
   target.

The script is **idempotent** — re-running replaces the install in
place. Existing files are overwritten (with a timestamped backup in
`--global` mode for the user's `opencode.json(c)`).

### 2. Two install modes

`--local TARGET_DIR` (default when a positional is given) is the
**project-scoped** install. The script writes:

```
<TARGET_DIR>/.opencode/plugin/   ← Slice 2 hook modules
<TARGET_DIR>/.opencode/skills/   ← Slice 2 skills, flat-symlinked
<TARGET_DIR>/opencode.json       ← Slice 1 provider block
```

Multiple RedSkills plugins share one `.opencode/` root. A skill
collision across plugins is a build error caught by Slice 2's name
validation (ADR 0076 §1); a hook module collision across plugins is
not possible today because each event class is owned by a single
source file.

`--global` is the **user-scoped** install. The script writes:

```
~/.config/opencode/plugins/redskills-<plugin>-<event>.ts   ← flat
~/.config/opencode/skills/<name>/SKILL.md                  ← flat per name
~/.config/opencode/opencode.json                            ← provider block
```

The flatten is dictated by opencode's non-recursive loader. The
provider block goes into the user's `opencode.json(c)`; if the file
already has content, the script backs it up first. Skills from
multiple plugins with the same name collide and the second install
overwrites the first — the Slice 2 build error would have caught
this upstream, so a runtime collision is a Slice 2 bug, not a
runtime concern.

### 3. The `cp -Rn` flag prevents accidental overwrites in local mode

The local install uses `cp -Rn` (no-clobber) when copying skills
into the target. This is conservative: a user who has manually
customised a skill under `<target>/.opencode/skills/<name>/` keeps
their version, and the install log reports a one-line note instead
of silently overwriting. Hook modules are still overwritten because
the generator is the single source of truth for the hook TS
content (per ADR 0077).

### 4. `--copy` flag switches symlink to copy

The default install symlinks `SKILL.md` from the source tree into
the target. This preserves the single-source-of-truth property (an
edit to the source is visible on the next opencode session) but
breaks on cross-filesystem installs (the absolute symlink resolves
to a path the target cannot reach). The `--copy` flag forces a
copy and is the recommended path for `~/.config/opencode/skills/`
when the source lives on a different filesystem.

### 5. `--dry-run` prints the steps without writing

The script's `--dry-run` mode runs the generator (because the
install steps depend on the dist tree existing) but skips the
filesystem writes. A user can preview what an install will do
before committing to it; CI can verify the script's contract
without polluting the workspace.

### 6. The CLI command is `generate`; the script is the wrapper

`apps/opencode-host/src/generate.ts` continues to be the canonical
CLI surface. The script is a thin wrapper that:

- Resolves defaults (`--config .red/config.yaml`, `--plugins-root
  ./plugins`, `--out-dir ./dist/opencode`).
- Picks between the bundled form and the `tsx` form based on
  whether the bundle exists.
- Decides between `--local` and `--global` layout based on the
  flag.

The script does **not** extend the generator — adding a new install
mode (e.g. a future `--nix` for NixOS package install) is a script
change, not a generator change.

## Considered options

- **Auto-run the install from `setup-red-skills`** — rejected: the
  install mutates `~/.config/opencode/`, which is outside the
  red-skills source tree. `setup-red-skills` is the gated, opt-in
  step that creates `.red/`; it is the wrong blast radius for
  global opencode config changes. The install script is opt-in
  (`--global` is explicit) for the same reason.
- **Generate directly into `~/.config/opencode/`** — rejected:
  couples the generator to the user's global config, breaks the
  one-source-per-output contract (ADR 0039), and removes the
  staging step the local install needs. The two-step
  generate-then-install shape is what makes local + global share
  one code path.
- **Add an npm-distributable `redskills-opencode-host` CLI** —
  rejected: adds a publish pipeline, version coordination, and an
  install step that the bundling path already handles. Slice 5
  (remote install via release asset) is the right place to add
  that; Slice 2.1 ships the local checkout path.

## Consequences

- A user cloning the repo runs `scripts/install-opencode.sh
  /path/to/their-project` and the project is opencode-ready. The
  install is one command, idempotent, and the script's `--dry-run`
  flag previews the steps.
- A user adopting opencode as their primary agent runs
  `scripts/install-opencode.sh --global` once and the same
  `opencode .` in any directory picks up the RedSkills skill +
  hook surface.
- The script does not extend the Slice 1 + 2 generator contract;
  it is a thin wrapper. Slice 3+ work (MCP passthrough, agents)
  will extend the generator, and the install script picks up the
  new outputs without changes.
- The `--global` install is the documented path for opencode as a
  third host. The Slice 5 (remote install via release asset) will
  be a one-line add to the install script (`--remote <url>`) and
  a change to the release pipeline; it does not require new
  adapter code.
- A user who already has skills in their `~/.config/opencode/skills/`
  with names that overlap with the RedSkills curated set will see
  a silent overwrite on `--global`. Slice 2's build-time
  validation is the upstream guard; runtime collision is a known
  risk and is documented in the install script's log output.

## Status

Accepted. Implements the Slice 2.1 install surface of the
opencode-host plan. The Slice 1 + 2 generator contract
(ADR 0075 / 0076 / 0077) is unchanged; this ADR adds the
operational install wrapper.

## Amendment 1 — RedCode host destination

The same generated OpenCode-compatible surface may be installed for RedCode
with `scripts/install-opencode.sh --global --host redcode`. Global state is
isolated under `~/.config/redcode/`; OpenCode continues to use
`~/.config/opencode/`. Detection, installation, manifests, and uninstall run
independently so choosing RedCode never mutates an existing OpenCode setup.

## Related

- **0075** — Slice 1 (provider block).
- **0076** — Slice 2 (skills).
- **0077** — Slice 2 (hooks).
- **0034** — `apps/<plugin>/` layout; the install script reads
  from the same `plugins/` tree the generator reads.
- **0038** — runtime ships as a fetched Release asset; the
  install script's bundle-then-tsx fallback is the local-dev
  shape of that.
- **0039** — plugin entrypoints share one source; the install
  script's `redskills-<plugin>-<event>.ts` naming convention
  follows the same source-of-truth pattern.
- **0067** — strict opt-in gate; the install script aborts when
  `plugins.dev.enabled: true` is missing.
