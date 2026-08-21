---
"@reddb-io/protocol-acp": patch
"@reddb-io/worker": patch
"@reddb-io/redskilled": patch
---

The land request names the validated commit and the merge driver remembers the
head it armed. Publish carried a commit and land dropped it, so the daemon
landed a mutable branch ref and the driver, keyed by PR number alone, was
blind to a head that moved between arming and merging. The Worker's land now
sends the same commit its publish named, the daemon refuses a landing without
it, custody records round-trip the armed head through their TOON snapshot, and
a driver pass against a moved head reports the mismatch instead of arming a
commit nobody validated.
