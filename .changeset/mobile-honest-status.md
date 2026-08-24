---
"@reddb-io/redskilled-mobile": patch
---

The mobile host card derives its status from evidence — the last state read that answered (connecting / online <10s / stale <30s / unreachable) — instead of a hardcoded "online"; failed reads surface their reason; dispatch draws a pending row the Host's own list reconciles away; Worker rows show the published phase and heartbeat age from the v2 snapshot; the preview gateway serves the same v2-shaped snapshot.
