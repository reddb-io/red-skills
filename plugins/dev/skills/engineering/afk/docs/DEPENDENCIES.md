# Dependency Unblock — `req:N` edges

Dependencies are **`req:N` edge labels** (one per blocker), and a blocked issue holds **`blocked:dependency`** state (not `ready-for-human` — it is healthy, waiting, never pages).

Two mechanisms promote it to `ready-for-agent`:

1. **Close cascade** — immediately after closing issue #N, re-evaluate every dependent and promote it if all its `req:*` issues are now closed.
2. **Unblock sweep** — boot-time safety net that re-scans `blocked:dependency` issues and promotes any whose deps all closed.
