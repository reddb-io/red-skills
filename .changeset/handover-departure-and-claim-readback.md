---
"@reddb-io/red-skills": patch
---

An incumbent daemon leaves after handing over, and an unbelievable claim read-back stops looking like a lost race

Two host-level failures that stopped the drain for hours on 2026-08-19.

A daemon that handed its session to a successor released the socket, the lease
and the machine claim — and then stayed alive. It served nothing, answered
nothing, and still counted as the host's daemon to every liveness surface and to
the unit supervising it. One sat that way for 25 minutes with no socket in the
runtime directory and no Worker was born until an operator restarted the unit by
hand. The incumbent now exits on both handover paths.

Claim verification read back an EMPTY comment list for an issue that held five
comments, including the claim comment the Worker had just written. The Worker
read that as a lost race and conceded; three concessions tripped the claim healer
and quarantined four healthy Tickets. An all-empty read-back is now classified as
`infrastructure` — a read that cannot be believed — and reported as such instead
of as a claim that could not be written.
