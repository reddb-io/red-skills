# @reddb-io/red-skills

The RedSkills plugin runtime bundles (`dev`, `code-nav`, `memory`, `brain`), distributed over
**npm** — the v2 client transport (ADR 0091), replacing the broken GitHub-release
+ hand-rolled sigstore channel.

The tarball carries the platform-independent JS bundles under `dist/` plus bin
shims (`red-skills-dev`, `red-skills-code-nav`, `red-skills-memory`,
`red-skills-brain`) that exec the corresponding packaged bundle. **No
postinstall download** — the bundles ship in the tarball, so integrity is npm's
own shasum/provenance and delivery is atomic.

## Client resolution

The RedSkills launchers resolve the exact pinned version via npm
(`npm install @reddb-io/red-skills@<version>` / `npx -y @reddb-io/red-skills@<pin>`
semantics), cache-first. See `packages/shared/bundle-fetch.ts`. The `canary`
channel is the npm `canary` dist-tag.

## Divergence from reddb's postinstall-fetch pattern

reddb's sibling package fetches per-platform **Rust** binaries in a postinstall
step. RedSkills bundles are **platform-independent JS** (~2MB each) that fit
inside the tarball, so we ship them directly — atomic delivery, registry
shasum/provenance integrity, no postinstall network hop. (The Memory/Brain
runtimes' native `red` engine binary is the one per-platform artifact that
cannot live in the tarball; those plugins resolve it separately at runtime.)

## Publishing

The Release standard owns the package's product version and `vX.Y.Z` tag (ADR
0139). Built bundles are staged into `dist/` by `scripts/prepare.mjs` before a
registry pack or publish operation; the removed legacy publish workflow is no
longer a second release owner.
