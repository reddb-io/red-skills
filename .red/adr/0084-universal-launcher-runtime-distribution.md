# Plugin runtime distribution — the launcher + Release-bundle pattern is universal

## Status

Accepted (planning). Decided in the same `/start` grilling session as ADR 0083,
for the reliability program queued behind PRD #907/#928. Extends ADR 0038/0039
from the dev plugin to memory and brain.

## Context

RedSkills plugins install through the plugin marketplaces of Claude Code,
Codex, and OpenCode. The marketplace copy carries the **definitions** —
manifests, skills, hooks wiring — but not the built **runtime**: `dist/` is
gitignored, so it never reaches the installed copy. The dev plugin solved this
with ADR 0038/0039 (a tiny committed launcher fetches the versioned bundle
from the GitHub Release into `~/.cache/red-skills/bundles/`); memory and brain
did not, so their hooks **silently no-op** in installed copies — the worst
failure mode, because nothing reports it.

Two adjacent lessons constrain the design: PR #379 (statusline blanked when a
launcher fetched synchronously in the render path — surfaces must read from
cache), and the version-pinned launcher dance (running a just-released bundle
required hand-downloading it into the cache).

Alternatives considered: committing `dist/` into the repo (bloats history,
creates a second distribution mechanism next to dev's launcher), and
build-on-install via `/setup-red-skills` (requires the user's machine to carry
a node/pnpm toolchain; slow and fragile).

## Decision

One distribution model for all three plugins:

1. **Install channel**: the marketplaces (Claude Code / Codex / OpenCode) ship
   plugin definitions only. Nothing else is a supported install path.
2. **Activation**: per-directory strict opt-in via `plugins.<name>.enabled` in
   `.red/config.yaml` (ADR 0067, unchanged). `/setup-red-skills` remains the
   sole creator of `.red/`.
3. **Runtime**: every plugin (dev, memory, brain) ships a small committed
   launcher that resolves its Release bundle into
   `~/.cache/red-skills/bundles/` on the first *enabled* session start.
   Launchers self-update the bundle **within the compatible version range, in
   the background** — never synchronously in a render or hook path; all
   surfaces (statusline, hooks) execute from the cached bundle.
4. **Authenticity**: bundle manifests are signed by the `red-release` workflow
   with **sigstore/cosign** keyless GitHub Actions OIDC. The signature bundle is
   published beside the manifest as a Release asset and the shared launcher
   verifies it after checksum verification and before writing to cache. Rekor is
   recorded by release signing, but fetch rejects missing or invalid signatures
   from the local signature bundle rather than depending on an online Rekor
   lookup.
5. **Control plane**: `/setup-red-skills` (one-time) and `/doctor` (recurring)
   are the surfaces that explain what is enabled and healthy. `/doctor` audits,
   per plugin: enabled-in-config vs runtime-present, bundle version vs latest
   Release, and cache freshness — closing the "hook enabled but runtime
   missing/stale" hole as a *reported* condition instead of a silent no-op.

## Consequences

- Memory and brain hooks stop no-oping in installed copies; the failure mode
  becomes a visible doctor finding.
- The "download the bundle by hand to run a fresh release" dance disappears
  for in-range updates; explicit pins remain possible for out-of-range jumps.
- Release CI must publish bundles for all three plugins, not just dev.
- A compromised Release cannot make a launcher cache a malicious bundle by
  replacing both bundle and checksum manifest unless it can also produce a valid
  cosign signature for the `red-release.yml` GitHub Actions identity.
- Bundle fetch requires network on first enabled boot; offline first-boot
  degrades to inert-with-doctor-finding, not a crash.
- A second mechanism (committed `dist/`, build-on-install) is explicitly
  rejected; any future plugin adopts the launcher pattern by default.
