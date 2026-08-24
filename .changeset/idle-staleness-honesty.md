---
"@reddb-io/redskilled": patch
---

The payload's staleness on a zero-Worker host now derives from the daemon's own request-health beat instead of a hardcoded `false` — an idle-but-broken daemon can no longer wear a green "live" badge on any consumer; a daemon reporting no beat keeps the old calm answer.
