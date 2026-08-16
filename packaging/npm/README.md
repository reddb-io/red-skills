# @reddb-io/red-skills

The RedSkills core package distributed over **npm**. It carries compatibility
bin shims, marketplace manifests, host generators, and the non-plugin runtimes
those surfaces consume.

Each plugin runtime now ships beside its skills in
`@reddb-io/red-skills-<plugin>` (ADR 0146), so the core tarball does not duplicate
`dev`, `internal`, `memory`, or `brain`. The standalone installer materialises
the core and exact-version plugin packages into one installed tree; the retained
bin shims execute the bundles from that composed tree.

## Client resolution

The RedSkills launchers first resolve an exact-version bundle from the installed
tree. When that version is absent, they materialise its per-plugin package via
npm. See `packages/shared/bundle-fetch.ts`. The `canary` channel remains the npm
`canary` dist-tag and deliberately bypasses the stable installed tree.

## Divergence from reddb's postinstall-fetch pattern

reddb's sibling package fetches per-platform **Rust** binaries in a postinstall
step. RedSkills bundles are **platform-independent JS**, so each plugin package
ships its bundle directly — atomic delivery, registry shasum/provenance integrity,
no postinstall network hop. (The Memory/Brain
runtimes' native `red` engine binary is the one per-platform artifact that
cannot live in the tarball; those plugins resolve it separately at runtime.)

## Publishing

The Release standard owns the package's product version and `vX.Y.Z` tag (ADR
0139). Non-plugin supporting bundles are staged into core `dist/` by
`scripts/prepare.mjs`; plugin bundles are staged into their derived packages by
`scripts/build-pi-packages.mjs` before the registry pack/publish operation.
