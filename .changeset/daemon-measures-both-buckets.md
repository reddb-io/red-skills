---
"@reddb-io/github": patch
"@reddb-io/red-skills": patch
---

The App is measured, not just spent

A host declaring a GitHub App had two payers and one measurement. The daemon is
the only process that writes the balance surfaces, and it asked exclusively on
the operator's token: `balance.toon` held the person's ceiling, every
`balance-history.toonl` row was stamped `pat`, and
`balance-app-<installation>.toon` — named in the contract, exercised only by
tests — was written by nobody. Meanwhile the App's bucket was spent entirely by
other processes, so an installation carrying thousands of reads an hour appeared
on no surface at all. A consumer plotting the machine saw one sawtooth and
believed it was the whole story.

The daemon now reads the `github_app` block from the host policy file and
measures that ceiling beside the operator's, on the App's own installation
token. Each payer writes its own snapshot, because two buckets summed into one
document would have to pick an owner and the last writer would become the
displayed truth for a ceiling the next request may not draw from. Both write
their rows into the one history lane, labelled — one curve file, two separable
series.

The App is a payer to MEASURE here, never a credential the daemon acts as: it
authenticates no write and routes no read, and a misdeclared block answers
`null` rather than refusing to boot, because a daemon that would not serve a
host over an optional number trades the machine for a graph.

The dev runtime's spend ledger gained the same stamp. It recorded WHAT was spent
and never WHOSE, so a host running both an App and a token produced one
undifferentiated total — a number no ceiling could be checked against.
