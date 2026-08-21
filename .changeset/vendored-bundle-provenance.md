---
"@reddb-io/release": patch
---
The vendored release engine now carries a checkable claim instead of having one inferred from minified bytes. `.github/red-skills/release.bundle.provenance.toon` records the bundle's hash, every first-party module esbuild consumed with its content hash, and the toolchain that built it; the guard rehashes those paths with no build at all. A source change still fails and names the files that moved; a machine whose esbuild resolves to a different patch of the catalogued range no longer reads as source drift. `pnpm -C apps/release vendor:refresh` writes the bundle and the record together.
