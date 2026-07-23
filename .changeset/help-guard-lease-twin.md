---
"@reddb-io/red-skills": patch
---

`red-skills-dev --help`/`-h` now prints usage and exits instead of falling through to the run surface and booting a live worker drain (#2581). The local issue-lease twin over `.red/tmp/claims/` is unified (#2578): castle's `createFsIssueLeaseStore` absorbs the battle-proven #434/#568 semantics (atomic non-recursive-mkdir lock, atomic-rename steal, injected pid/owner liveness) and writes both `pid` and `owner` files, `apps/dev` claim locking rebinds to it, and the non-atomic twin plus `tryAcquireClaimDir` are deleted — every existing `pid`-file sweep reader keeps working unchanged.
