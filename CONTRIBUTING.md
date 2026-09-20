# Contributing

Edit content here and software in the sibling `redskilled` repository. Keep scripts,
hooks, installers, generators, tests and release automation implementations there.
Manifests here may declare commands and arguments, but may not embed shell programs.

From a sibling Redskilled checkout, validate a candidate without building the runtime:

```sh
node scripts/check-skills-boundary.mjs ../red-skills
node scripts/generate-codex-manifests.mjs --root ../red-skills --check
node scripts/generate-gemini-manifests.mjs --root ../red-skills --check
node scripts/generate-pi-manifests.mjs --root ../red-skills --check
```

Omit `--check` to regenerate manifests after editing the canonical Claude manifests.
Run these against the actual content worktree path when using isolated worktrees.
CI calls the same tools through a commit-pinned Redskilled reusable workflow.

For a new runtime capability, first publish the compatible Redskilled runtime, then
update `runtime.toon` and the content declarations. Coordinate both PRs with links.
A content-only change does not require a daemon version bump. Redskilled publishes
Pi/npm content packages from its pinned skills revision.

Use fully qualified issue references across repositories. Preserve historical ADR
links; new software decisions belong to Redskilled. Keep the ask-red coverage
inventory current whenever a skill route changes.
