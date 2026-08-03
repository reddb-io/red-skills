---
"@reddb-io/redskilled": patch
---

Ask the kernel who owns the socket, not a 250ms clock

`bindExclusive` resolved an ambiguous `EADDRINUSE` — a live peer and the socket
file a crash left behind look identical on disk — by pinging the path and
treating silence as debris to unlink. A ping asks whether the owner is HEALTHY,
and health is not title: a daemon busy on a long request, or hung in a shutdown
drain, fails a 250ms ping while owning its socket completely. Reading that
`false` as an absent owner unlinked live sockets out from under running daemons,
which then went on believing they were the machine's single arbiter.

One host recorded **1166 daemon births in a day**, 985 of them living two seconds
or less, with **four daemons `serving` simultaneously**. Each theft also dropped
the standing project registrations onto a daemon nobody would reach again.

Ownership is now asked of the kernel: a `connect()` that succeeds proves a
listener is bound, whether or not it ever replies; only `ECONNREFUSED`/`ENOENT`
proves the inode is debris. An unresolved probe keeps the path, because the two
mistakes do not cost the same — refusing to start loses one daemon that says
why, and unlinking a live socket loses every client that came after it, silently.
The lease and the machine claim are consulted as a second belt: a probe is not
owed the last word over two records that already name a live pid.
