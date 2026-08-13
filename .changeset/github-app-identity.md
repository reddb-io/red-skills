---
"@reddb-io/github": minor
"@reddb-io/red-skills": minor
---

An operator may authenticate as a GitHub App, routed per repository

A Personal Access Token spends one bucket for the whole machine: the daemon's
queue poll, every Worker's reads and the operator's own commands draw from the
same 5,000 an hour, so one greedy surface starves the rest and no spend can be
attributed. A host may now declare a GitHub App instead — its installation
carries a separate bucket, states its permissions rather than inheriting
everything its owner can do, and is revocable without touching a person.

**The App does not replace the person; it is routed to.** An installation covers
an account while the daemon is host-global, so the operator is routinely in a
repository the App was never installed on — a personal repo, another
organisation, a fork. Those requests keep going out on the personal token, which
remains the floor. Coverage is asked once per repository and remembered on disk,
so the question costs one request rather than one per client, and an
unanswerable question records *unknown* rather than *not installed* so an outage
never masquerades as a verdict.

Two identities keep two balances, stored under separate names, and the two are
never summed: five thousand App requests cannot pay for a repository the App
does not cover, so a combined figure would report headroom the next request
cannot spend.

Declared with `RED_GITHUB_APP_ID`, `RED_GITHUB_APP_INSTALLATION` and
`RED_GITHUB_APP_KEY`, all three together — a partial declaration is refused
rather than falling back quietly to the shared bucket.
