---
"@reddb-io/red-skills": patch
---

A changeset that cannot resolve now fails its own PR instead of the next release (#2863). `changeset version` does not skip a file naming a package outside the workspace — it throws and abandons the whole release plan, so one file saying `"red-skills"` where every other one says `"@reddb-io/red-skills"` failed three consecutive release runs, left npm on the previous version, and reported nothing until someone opened the job log. `scripts/validate-changesets.mjs` resolves every pending changeset against the `pnpm-workspace.yaml` globs with no dependency on an installed `@changesets/cli`, names the offending file, the unknown package and the scoped name the author meant, and passes a repository with no pending changesets. It runs in `workflow-security` on purpose: `.changeset/` is inert to the affected-cone scoper, so a changeset-only PR narrows every other job away and that is exactly the PR carrying the defect.
