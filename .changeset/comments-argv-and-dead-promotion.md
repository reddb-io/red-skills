---
"@reddb-io/red-skills": patch
---

The comment reads leave the argv tier, and a promotion that never fired is deleted

Three `gh api … --paginate --jq` sites survived in the comment reader — the same
tier whose sibling took the whole sweep down when a flag combination the `gh`
binary refuses shipped inside it. Two of the three had no production callers at
all and are removed rather than migrated; the one real reader now paginates
through the shared client.

That reader decides whether a comment is CREATED or UPDATED, so it keeps its
discriminated result: a transport failure answers `{ok:false}` with the thrown
message, never a successful empty list. Degrading the two would post a duplicate
comment on every outage. It also takes its own cache namespace — four readers
share that route, and an idempotency check must not decide from a body another
reader cached.

A per-comment trust promotion goes with them. A maintainer's 👍 on one comment
promoted that comment alone, precedence rule 4 of 5 in the source-trust
taxonomy. It never fired in production: the field it read was supplied by no
reader in the repository, and the REST payload carries reaction COUNTS without
the reacting logins. Restoring the capability needs a per-comment
`…/comments/{id}/reactions` read — an N+1 on a client that exists to conserve
budget — which is a decision to take deliberately rather than a field to leave
dangling. The rule, its input, and its dead readers are removed, and a test now
pins the deletion instead of pinning the gap.
