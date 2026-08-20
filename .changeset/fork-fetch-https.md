---
"@reddb-io/redskilled": patch
---

The mirror trunk refresh fetches over anonymous HTTPS when the checkout's
remote is a GitHub SSH URL, and a fork that proceeds stale says so in the
journal. The daemon has no ssh-agent, so the SSH fetch failed silently and
every Worker still forked a days-old tree despite the refresh.
