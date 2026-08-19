# 0146 — One package per plugin, and the installed tree answers before npm

- Status: accepted
- Date: 2026-08-16
- Related: ADR 0034 (definitions/implementation split), ADR 0060 (Turborepo layout), ADR 0067 (plugin activation), ADR 0091 (npm bundle transport), ADR 0131 (vendored herdr plugin), red-dev ADR 0008 (who installs and wires it)
- Sources: the `/start` grilling session of 2026-08-16

## Context

Three artifacts carry RedSkills today and none of them is RedSkills:

- the release tarball extracted to `~/.red-skills/versions/<tag>` carries `plugins/**` and no bundles;
- `@reddb-io/red-skills` on npm carries `bin/` and `dist/` and no skills (`packaging/npm/package.json`);
- `@reddb-io/red-skills-<plugin>` carries `skills/**` and no bundles.

The runtime stitches them at first run: `bundle-fetch` materialises the npm
package (ADR 0091) while the host reads skills from wherever its marketplace was
registered. Nothing is wrong with either half; what is wrong is that a machine
must hold both, from two channels, and no single thing on it *is* the product.

Measured on one developer machine: `~/.red-skills/versions/` at 1003 MB across
14 extracted trees, `~/.red-skills/cache/` at 93 MB of retained tarballs, and
`~/.claude/plugins/cache/red-skills/` at 69 MB across 25 plugin copies —
about 1.16 GB, none of it pruned by anything. Each installed version is 40 MB,
of which `apps/` (23 MB), `packages/` (5.5 MB) and `packaging/` (3.3 MB) are
TypeScript source nobody on that machine executes; `plugins/` (3.3 MB) and
`dist/` are the parts with a job. One file, `memory.bundle.min.mjs` at 11 MB, is
58% of the published bundle set, and it is mostly `js-tiktoken` BPE tables
inlined by esbuild rather than anything the memory plugin wrote.

## Decision

**A plugin is one npm package, and it carries both halves.**
`@reddb-io/red-skills-<plugin>` gains its built bundle beside the `skills/**` it
already ships, so pi, mise and the standalone installer consume one tarball per
plugin instead of three artifacts per machine. `@reddb-io/red-skills` keeps only
what is not a plugin: the bin shims, the marketplace manifests, `scripts/` (the
host generators) and the `opencode-host` bundle. Monorepo source leaves the
artifact — `apps/`, `packages/`, `packaging/` and the lockfile are build inputs,
not install outputs.

The VS Code extension and the vendored herdr plugin become artifacts CI
publishes. They were the only reason an operator's machine needed the workspace
source at all, and building a `.vsix` on that machine is work CI does once.

**The installed tree answers before npm.** `~/.red/skills/versions/<version>/`
stays the on-disk layout and becomes the launcher's first stop, with `current`
naming the newest. (Amended 2026-08-19: the root is `~/.red/skills`, inside the
`.red` namespace with the rest of what red-dev keeps for a person; it was
`~/.red-skills` when this was written, and red-dev moves a machine across. The
layout beneath the root is unchanged, and `RED_SKILLS_INSTALL_ROOT` still
overrides it.) The launcher matches the version **exactly** — the version it
already reads from the nearest `.claude-plugin/plugin.json` — and falls back to
npm when the tree holds no such version. `distBundlePath()`'s `findUp` from the
launcher module stays what it is, a source-checkout fallback that cannot see
this tree: the host runs the launcher from its own plugin cache copy, several
directories away from anything the installer owns.

Exact match is the point. A 3.19 bundle under a 3.18 manifest is precisely the
skew that surfaces inside a hook, where nobody is watching. Keeping
`versions/<v>` populated for every version some host still has installed is what
stops that match from failing in the window after an upgrade.

Channels stay out of the tree. `canary` is a project choice read from
`.red/config.yaml`, it resolves to a version the tree does not hold, and it
therefore falls through to npm with no new code.

`scripts/install.sh` installs the same packages: it stops fetching the release
tarball, and `node` plus `npm` become hard preconditions that fail loudly —
`node` already was one, since the opencode/redcode/pi generators need it. Host
unwiring moves into a script inside the tree that both the installer and red-dev
call, because the conservative uninstall is driven by the manifest the generator
itself wrote, and two implementations of that diverge within a month.

The tokenizer tables come out of the memory bundle into an asset loaded on
demand, so they land only on a machine that actually tokenises.

**First slice is the artifact alone** — the package split and the shrunk core,
with no mise and no red-dev change. It pays for itself in the standalone path
and is the precondition for everything else.

## Consequences

- The host still keeps its own copy: Claude copies a plugin into
  `~/.claude/plugins/cache/` whatever the marketplace source is. This removes
  RedSkills' duplication, not the host's.
- Publishing gains a fan-out: one core package plus one per plugin, all on the
  same version train, which the existing version ratchet already governs.
- A machine that never runs `npm` can no longer install RedSkills at all. That
  is deliberate; the previous curl-and-tar path only appeared to avoid node.
- `packaging/pi/*` stops being a pi-only concern — the same package is now the
  plugin's artifact for every consumer.
