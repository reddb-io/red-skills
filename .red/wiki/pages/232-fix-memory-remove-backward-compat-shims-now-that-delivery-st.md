---
title: fix(memory): remove backward-compat shims now that delivery + store are clean
type: source
tags: [pr, merged]
created: 2026-05-29
updated: 2026-05-29
sources: [pr-232]
pr: 232
merge_sha: 2080bee0cd508268b3fc7748afb03863846a8588
---

# fix(memory): remove backward-compat shims now that delivery + store are clean

- **PR:** [#232](https://github.com/reddb-io/red-skills/pull/232)
- **Author:** @filipeforattini
- **Merge SHA:** `2080bee0cd508268b3fc7748afb03863846a8588`
- **Format:** merged pull request

## Summary

Removes dead backward-compat paths now that the runtime ships as a bundle (ADR 0029) and the store was rebuilt fresh. Single-path, cleaner runtime.

**Removed**
- **hooks (claude + codex):** the `[ -f cli ]` guard + `cat >/dev/null; printf "{}"` else-branch (old "dist not built" world). Now call the bootstrap directly; keep only `|| printf "{}"` resilience.
- **`vcs-commit::resolveRedBinary`:** the `import.meta.resolve("@reddb-io/sdk")` last-resort (throws in the bundle). `REDDB_BIN` → dev `node_modules` → clear error.
- **`graph-store`:** the "back-compat fallback for local projections written before the aggregate index existed" full-scan path.
- **`skill-events`:** legacy monolithic-key readers behind the partitioned scheme (`readSeenEventIds`, `SKILL_ROLLUPS_KEY`/`SKILL_EVENT_SEEN_KEY` reads, dead `parseKvObject` + key constants).
- **`hooks-manifest.test`:** rewritten for the bootstrap contract.

**Kept (not retrocompat):** the `deprecate` domain term (memory-decay keep/review/deprecate/expire) and `config.skillTelemetry?` (correctly-optional field).

**Validation:** typecheck ✅, bundle ✅, 855/858 unit tests pass. The 3 non-passes: `hooks-manifest` (fixed here), `http-server` (contention — passes isolated), `doc-search-cli` (pre-existing load-sensitive timeout — fails on baseline with these changes stashed, so unrelated). Net −37 lines.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/232"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782611182&installation_id=129708444&pr_number=232&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F232&signature=86a7ff7c70d6ac73cd6dcd80a151a380c6d6ea03f78166c0bdea76c4bc60f844"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- fix(memory): remove backward-compat shims now that delivery + store a…

## Files changed

- `plugins/memory/hooks/claude.hooks.json`
- `plugins/memory/hooks/codex.hooks.json`
- `plugins/memory/src/graph-store.ts`
- `plugins/memory/src/skill-events.ts`
- `plugins/memory/src/vcs-commit.ts`
- `plugins/memory/tests/hooks-manifest.test.ts`

