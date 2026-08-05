# Release standard: changeset-compatible queue, Version-PR trigger, calver inside semver

Status: accepted (design; implementation pending)

The reddb-io repos ship three divergent release schemes: red-skills runs changesets with a
Version-Packages PR, reddb runs changesets/action plus a manual `-rc.N` lane, and toon /
red-request abandoned changesets for conventional-commit auto-release scripts. RedSkills
formalizes ONE release standard that `/red-setup` provisions for any consumer repository,
and this ADR records the shape that standard takes.

## Decisions

1. **The interview is a `/red-setup` section, not a separate skill**, placed after the
   validation moments: a release consumes the gate's answer ("only tag what passed") and
   reuses the build commands the operator just declared.
2. **Changesets keep the market format and the market location.** Files live in
   `.changeset/` with changesets-compatible frontmatter (`"pkg": minor` + markdown prose),
   but a house engine consumes them. Format compatibility makes migration for existing
   changesets repos zero; the house engine is what unlocks calver and non-JS workspaces.
3. **One product version per workspace (single train).** The #3082 lesson — a package no
   train writes ships the wrong version forever — is imposed on consumers rather than
   re-learned by them. Independent per-package versioning is out of scope; the original
   `@changesets/cli` exists for that.
4. **Calver lives inside the semver space.** The scheme is semver or calver; calver is
   exactly `YYYY.M.MICRO` (e.g. `2026.8.2`), deliberately semver-parseable — no leading
   zeros — so npm, cargo, ranges, and the prerelease machinery never notice the
   difference. Under calver the changeset bump type is read as an **impact class**
   (notes grouping, breaking-change flags, manifest metadata), never arithmetic.
5. **The trigger is configurable, defaulting to Version-PR.** The engine maintains an open
   release PR that consumes the queue and bumps the version surfaces; merging that PR is
   the tag trigger — a release is an approvable, auditable artifact. `auto` mode consumes
   the queue directly on push for repos that prefer cadence over ceremony.
6. **Pre-release is RC graduation.** An RC (`X.Y.Z-rc.N`) is cut from the Version-PR's own
   branch state — same bump, same changesets — so the merge promotes byte-for-byte what
   the RC tested. A pre-release can never diverge from the release it precedes.
7. **No committed CHANGELOG.md.** The published Release is the canonical record: rendered
   notes for humans plus a **release manifest** attached as both JSON (interop for
   downstream CI/CD) and TOON (house doctrine), generated atomically from the same data.
8. **Version surfaces are confirmed at setup and enforced at release.** `/red-setup`
   detects the manifests that carry the version, the operator confirms, and the list is
   saved in `.red/config.yaml`; at release time the engine re-derives the real workspace
   and refuses the release on drift, naming the orphan package.
9. **The engine is its own app** (`apps/release/`, own shipped binary on the version
   train, inheriting the shipped-binary obligations). Generated workflows are thin and
   invoke it via the pinned ADR 0091 npx form by default; a vendored single-file mode
   emits the bundle into the consumer repo for restricted or air-gapped CI.
10. **red-skills dogfoods first.** The hardest monorepo migrates before toon, red-request,
    and reddb — the engine's own distribution channel is the first proof.

## Considered options

Rejected: wrapping `@changesets/cli` (semver-only, package.json-everywhere); a
`.red/changesets/` location (the pending queue is transitory, not tracked knowledge, and
the point of format compatibility is looking like changesets from the outside); a
committed structured feed (a CHANGELOG.md in a new hat); pre-mode and continuous snapshot
channels as the core pre-release model (additive opt-ins later, not the standard); free
calver pattern strings (`0M` breaks semver parsing, ordering, and prerelease tags);
per-repo sync scripts as the only version propagation (the hand-kept drift the
version-train guard exists to refuse).
