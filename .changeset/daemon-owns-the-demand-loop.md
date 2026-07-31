---
"@reddb-io/red-skills": minor
---

**The daemon owns the demand loop: two players, one poller.**

A project no longer runs a process of its own. Its MCP **registers** — repository identity, an opaque selector, an opaque argv, a workspace path, a target — and the daemon polls the issue tracker for **every** registered project in a single aliased request, then decides when to ask for the next Worker. Cost is flat in the number of projects instead of linear in it, which is the whole point: GitHub quota is per token, so N pollers on one credential spend N times for the same answer.

A registration outlives the session that created it, so a drain keeps going after the terminal closes, and lapses when nothing renews it, so a closed laptop stops polling. A project whose queue genuinely empties leaves the list — and *genuinely* is load-bearing: a rate-limited fetch, an unreachable repository and an empty queue are now three distinguishable outcomes, because reporting a spent quota as "no work" is what once parked a fleet's slots for an hour while the tracker held four ready issues.

**Rule 3 survived the move.** The daemon matches a query to a result and starts a process with the argv it was handed. It still does not know what an Issue, a label, a Spec, a gate or a Landing *is*.

**A Worker's runner, model and effort stay decided per birth.** A runner is chosen when a Worker is born and swaps at runtime when one degrades mid-drain; model and effort resolve per tier, per run. A registration carrying one frozen argv could not have expressed that, and the change that removes the composing site was held until this was answered.

Also in this release: the daemon's wire and CLI speak TOON rather than JSON, and the ratchet that keeps the repository on TOON gained a second dimension so the next socket cannot be born JSON the way this one was; a pull request a Worker opens is born integrated with its base, so a conflict surfaces while the Worker is still alive to resolve it; an operator's installed plugin counts as evidence when resolving the published version; and a major-version gap is reported rather than silently held.
