# Releasing RedSkills

This is the internal deploy flow for maintainers of this repository. Consuming
RedSkills needs none of it — see [Install](../README.md#install).

Releases run on the Release standard (ADR 0139). Changesets-compatible files
remain the contributor-facing queue, while the house engine owns versioning,
tagging, notes, and manifests. **Nothing pushes a commit to `main`** — the
version bump is a reviewed PR like any other.

1. **Land your change with a changeset-compatible file.** Add a Markdown file
   under `.changeset/` with package impact frontmatter and one consumer-facing
   summary. A change without one accumulates no release intent.
2. **[red-release.yml](../.github/workflows/red-release.yml) maintains the
   Version-PR.** It invokes the pinned `red-skills-release` engine on every push
   to `main`. The engine consumes the queue, writes every confirmed
   `release.version_surfaces` entry, and opens or updates
   `red-release/version-pr`.
3. **Merge the Version-PR to publish.** The merge event runs the same engine at
   the merge commit. It creates `vX.Y.Z`, publishes rendered notes, and attaches
   `release-manifest.json` plus `release-manifest.toon`. Every step is
   idempotent, so a rerun converges rather than duplicating a tag or asset.

A shipped daemon keeps itself current without any of this: it resolves the
published version on its own tick, finds a successor running exactly that
version, hands over the socket and the lease, and lets the successor re-adopt
every Worker off the event lane. A **major boundary is held and the hold is said
out loud** — `upgrade.major_held` and `upgrade.major_hold` name the newest
release and the manual step that crosses it — because a breaking change must not
arrive on a machine that is holding Workers just because a timer noticed it.
