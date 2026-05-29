---
title: feat(memory): ship runtime as bundled release asset + bootstrap fetch (ADR 0029)
type: source
tags: [pr, merged]
created: 2026-05-29
updated: 2026-05-29
sources: [pr-229]
pr: 229
merge_sha: 8905f106a9e99cc78ddfdb47f9d77979fc814bdd
---

# feat(memory): ship runtime as bundled release asset + bootstrap fetch (ADR 0029)

- **PR:** [#229](https://github.com/reddb-io/red-skills/pull/229)
- **Author:** @filipeforattini
- **Merge SHA:** `8905f106a9e99cc78ddfdb47f9d77979fc814bdd`
- **Format:** merged pull request

## Summary

Makes the Memory lifecycle hooks actually run in installed copies. Supersedes #228.

## Why #228 wasn't enough
Committing `dist/` ships the JS but not its 137 MB of deps (`@reddb-io/sdk`, `zod`, `gray-matter`, `fast-glob`, `@mcp/sdk`) — the ESM CLI still crashes `ERR_MODULE_NOT_FOUND`, swallowed by the hook's `|| printf "{}"`. And memory connects `file://…/graph.rdb` → SDK embedded mode → spawns the native `red` binary (~25 MB, per-platform). None of that survives a git-checkout install + `autoUpdate`.

## Approach (ADR 0029)
Deliver the runtime as **fetched artifacts**, never committed build output, never a local install:

- **esbuild bundle**: `src/cli.ts` → one platform-independent `memory-cli.mjs` (~1.9 MB, all JS deps inlined). Published as a release asset + a `memory-runtime-manifest.json` pinning its sha256 and the reddb tag.
- **`red` binary**: reused per-platform from `reddb-io/reddb` releases (the same source the SDK postinstall uses), verified against the published `.sha256`.
- **`scripts/bootstrap.mjs`** (only `node:` builtins): resolves/fetches both into `~/.cache/reddb-memory/<ver>/` (version-keyed, **survives autoUpdate**, re-fetched only on version change), verifies checksums, exports `REDDB_BIN`, delegates the hook. On failure → preserves the no-op contract **and logs to `bootstrap.log`** (no more silent death). `REDDB_BIN` being set means `import.meta.resolve` never fires — no source refactor needed.
- **hooks** (`claude`/`codex`) now invoke the bootstrap instead of `dist/cli.js`.
- **`red-release.yml`** builds the bundle + manifest and attaches them at `gh release create`.

## Validation
- Spike proven locally: bundle runs **standalone with no `node_modules`**; an engine command fails only at `red binary not found` (overridable via `REDDB_BIN`), not at module resolution.
- `pnpm typecheck` ✓, `tests/bootstrap.test.ts` ✓ (6 pure-helper tests), `validate-install-metadata.sh` ✓.
- CI here will exercise the release bundle path.

## Follow-ups (not in this PR)
- MCP server (`mcp-server.ts`) is a separate entry — bundle it too if/when MCP ships enabled.
- First-session-after-update download latency is one-time per version; could be backgrounded.

Closes the operational-delivery half of PRD #217 / ADR 0027.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/229"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782605102&installation_id=129708444&pr_number=229&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F229&signature=7a7b3dde9a5eb565410a433c28b44bd2f6322180c59fbe1aad6a8be5b9fe1613"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- feat(memory): ship runtime as bundled release asset + bootstrap fetch…

## Files changed

- `.github/workflows/red-release.yml`
- `.red/adr/0029-memory-runtime-ships-as-a-bundled-asset-fetched-by-a-bootstrap.md`
- `plugins/memory/.gitignore`
- `plugins/memory/hooks/claude.hooks.json`
- `plugins/memory/hooks/codex.hooks.json`
- `plugins/memory/package.json`
- `plugins/memory/pnpm-lock.yaml`
- `plugins/memory/scripts/bootstrap.mjs`
- `plugins/memory/tests/bootstrap.test.ts`

