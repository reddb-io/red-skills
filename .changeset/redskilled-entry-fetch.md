---
"@reddb-io/red-skills": patch
---

A host that has never cached the `redskilled` bundle now fetches one instead of dead-ending. The daemon entry resolver walked local paths only — a pinned env var, the caller's entry, a sibling bundle, the bundle cache — and every one must already exist, so on a fresh machine there was nothing to auto-spawn and rule 7's "a daemon starts on first use" quietly did not hold. `/red-setup` then answered by telling the operator to run `redskilled provision`, the binary that only exists after the thing it is meant to install: the instruction pointed at its own precondition. The resolver gains the missing rung, the same `ensureBundle` the dev launcher already uses. A local entry still wins, so a checkout never loses to a published bundle; the fetch is cache-first, so a warm host pays nothing; and a fetch that cannot run leaves the original diagnostic intact, because "here is every path I looked at" helps an operator more than "npm failed".
