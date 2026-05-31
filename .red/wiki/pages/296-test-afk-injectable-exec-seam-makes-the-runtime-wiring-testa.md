---
title: test(afk): injectable exec seam makes the runtime wiring testable
type: source
tags: [pr, merged]
created: 2026-05-31
updated: 2026-05-31
sources: [pr-296]
pr: 296
merge_sha: 1b80c75c5fe32e1c606a46bdbcf177d78c460892
---

# test(afk): injectable exec seam makes the runtime wiring testable

- **PR:** [#296](https://github.com/reddb-io/red-skills/pull/296)
- **Author:** @filipeforattini
- **Merge SHA:** `1b80c75c5fe32e1c606a46bdbcf177d78c460892`
- **Format:** merged pull request

## Summary

Architecture review candidate #2. Adds the optional exec Seam to GhContext/GitContext so the real buildProcessDeps assembly can be driven over a recording fake exec; new integration test asserts the full DONE close-path OS-command trace (argv+cwd) over the real closures. Production untouched (exec unset by default). 700 tests. [skip release].

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/296"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782790740&installation_id=129708444&pr_number=296&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F296&signature=008d3bb7d1a85f96b6599a3932d4eed0b144229786243a1e2dad88db3a6486cf"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- test(afk): injectable exec seam makes the runtime wiring testable

## Files changed

- `src/domains/dev/src/commands/run.ts`
- `src/domains/dev/src/runtime/exec.ts`
- `src/domains/dev/src/runtime/gh.ts`
- `src/domains/dev/src/runtime/git.ts`
- `src/domains/dev/tests/wiring-integration.test.ts`

