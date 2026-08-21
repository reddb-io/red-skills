---
"@reddb-io/redskilled": patch
---

A silently dead Worker leaves the account it never got to write. A death whose
receipt names no sender at an actionable confidence — the set the checkout sweep
deliberately defers — now appends a second `worker-postmortem` row beside it on
the daemon's registered event lane, carrying the failure mode as a structured
`failure_mode` field (`oom`, `cap-hit`, `unattributed-kill`, `host-vanished`,
`unknown`) and every last thing the host held about that Worker in one line: when
it was born, what its tree had burned, the ceiling it ran under, the signal or
receipt if either spoke, the journal tail, and the path to its own narration.
