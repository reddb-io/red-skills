---
"@reddb-io/dev": patch
---

Ship the changesets-flow reliability tail that landed after the v2.79.0 npm
publish was cut from the pre-migration branch: ordered publish retries with
tail reconciliation, CI running on the `changeset-release/main` branch, the
bypass-credential check scoped to the release flow, and the release/README
documentation for the Version Packages PR + tag-triggered `red-publish` flow
(ADR 0121). This cut also re-aligns the published npm content with `main`,
which the transitional v2.79.0 tarball predates.
