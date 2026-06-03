---
title: fix(statusline): resolve the AFK bundle by version (sort -V), not mtime
type: source
tags: [pr, merged]
created: 2026-06-03
updated: 2026-06-03
sources: [pr-412]
pr: 412
merge_sha: daf902c71e96b5e2e5531e980f78ebbefde902f9
---

# fix(statusline): resolve the AFK bundle by version (sort -V), not mtime

- **PR:** [#412](https://github.com/reddb-io/red-skills/pull/412)
- **Author:** @filipeforattini
- **Merge SHA:** `daf902c71e96b5e2e5531e980f78ebbefde902f9`
- **Format:** merged pull request

## Summary

The statusline command resolved the bundle/version with `ls -t … | head -1` — **newest by mtime, not highest version**.

**Demonstrated live** on a real plugin cache:
```
ls -t  .../dev/ | head -1   → 1.153.0   ← OLD version (older dir, newer mtime)
ls -1  .../dev/ | sort -V | tail -1 → 1.154.0   ← correct
```
So the statusline could run an **old bundle** whenever mtime stops tracking version (re-extract / cache repair / restore / rsync). A plain name sort also breaks at `1.9 → 1.10`.

**Fix:** `ls -1 … | sort -V | tail -1` (semver-aware) in the `setup-statusline` command + `setup-red-skills` Section F command (cached-bundle path **and** plugin-cache fallback), rationale prose updated "newest" → "highest-version".

The ADR 0038 launcher (`afk.mjs`) is unaffected — it resolves by reading `plugin.json` version, never mtime.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/412"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783039762&installation_id=129708444&pr_number=412&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F412&signature=74458f12b3ec1ed15455a565c18de5cfd20f2b993c8ea4e3d8a0c2ea8ffd69cc"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Documentation**
  * Updated setup-red-skills and setup-statusline skill documentation to clarify bundle selection behavior
  * Enhanced verification examples to reflect current selection logic

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(statusline): resolve the AFK bundle by version (sort -V), not mtime

## Files changed

- `plugins/dev/skills/engineering/setup-red-skills/SKILL.md`
- `plugins/dev/skills/engineering/setup-statusline/SKILL.md`

