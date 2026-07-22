# @reddb-io/dev

## 2.79.1

### Patch Changes

- 46aed06: Ship the changesets-flow reliability tail that landed after the v2.79.0 npm
  publish was cut from the pre-migration branch: ordered publish retries with
  tail reconciliation, CI running on the `changeset-release/main` branch, the
  bypass-credential check scoped to the release flow, and the release/README
  documentation for the Version Packages PR + tag-triggered `red-publish` flow
  (ADR 0121). This cut also re-aligns the published npm content with `main`,
  which the transitional v2.79.0 tarball predates.
  - @reddb-io/shared@2.79.1
  - @reddb-io/build-info@2.79.1

## 2.79.0

### Minor Changes

- 31b4f21: Releases now flow through a changesets Version Packages PR and a tag-triggered
  publish workflow (ADR 0121). The version bump lands as a normal reviewed PR
  instead of being pushed straight to protected `main`, which retires the
  `RED_RELEASE_TOKEN` admin bypass, the GH006 side-branch fallback,
  `release-push-bump.sh`, and the conventional-commit bump decider.

### Patch Changes

- @reddb-io/shared@2.79.0
- @reddb-io/build-info@2.79.0
