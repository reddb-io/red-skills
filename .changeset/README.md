# Changesets

This folder holds the pending release intents for `red-skills`. Every
user-visible change lands with a changesets-compatible Markdown file;
`red-release.yml` turns the queue into a **Version-PR**, and merging that PR
publishes the next `vX.Y.Z` Release.

## Adding a changeset

Add a uniquely named Markdown file with changesets-compatible frontmatter and a
consumer-facing summary, then commit it with your change:

```markdown
---
"@reddb-io/dev": patch
---
Describe the user-visible change.
```

## One version for the whole product

The confirmed `release.version_surfaces` list in `.red/config.yaml` puts every
workspace and marketplace manifest on one product version. The Release standard
re-derives the workspace before writing and refuses an undeclared package.

## What NOT to do

- Do not hand-edit a `version` field. The Release standard is the only writer;
  the version-train invariant fails CI when a version or declaration drifts.
- Do not push a version bump to `main` directly. The Version-PR is the
  only path, and it passes branch protection like any other PR.
