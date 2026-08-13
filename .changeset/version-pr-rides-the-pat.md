---
"@reddb-io/red-skills": patch
---

The release train stops blocking itself

The job that maintains the Version PR pushed its branch with `GITHUB_TOKEN`,
and GitHub starts no `pull_request` runs for a ref a bot pushed. So the PR's
required checks never began, branch protection blocked the merge indefinitely,
and every release needed a human to hand-push an empty commit from a personal
credential before it could land at all. Two releases went out that way.

The credential was never missing: the sibling job fifteen lines below already
uses `RELEASE_PAT`, with a comment stating the identical rule for tags. ADR 0121
had also already stated the requirement this violated — *"That PR passes branch
protection exactly like a human PR — no bypass token, no fallback, no direct
push."* The ADR 0139 rewrite simply dropped the token from the version-branch
job.

The guard for exactly this failure existed too, and watched it happen. Its
header reads *"This bit twice in one day."* It never inspected the release
workflow because it recognised a push only as a literal `git push` or a
`changesets/action` step, while the house engine pushes from inside its own
bundle. It now recognises both invocation shapes, so a pushing workflow that
spells neither cannot slip past a third time.
