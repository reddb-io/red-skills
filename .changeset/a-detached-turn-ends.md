---
"@reddb-io/red-skills": patch
---

A busy Worker whose client left is finished or it is leaked

The connection-close loop reaped idle Workers and SKIPPED busy ones, so a turn
that never completed — an answer notified to a dead upstream, a child that
never ends — held a host slot forever. Measured live: Workers alive 56 minutes
for clients gone 55 of them, while other projects were refused with "past a
host ceiling of 5 Worker(s)". A stuck Worker does not waste its own slot; it
starves every project on the machine.

On close, an ordinary prompt turn with no client is now cancelled — its answer
has no reader — and the cancellation carries a deadline, because a cancel
nobody bounds is the same eternal wait wearing a politer name. A DISPATCHED
Ticket turn is deliberately spared: it publishes through the daemon and its PR
is useful with nobody watching (#3885). The grace wait is declared in
`DECLARED_WAITS`, which is the ratchet that caught it being undeclared.
