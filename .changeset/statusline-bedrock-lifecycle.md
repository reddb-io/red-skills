---
"@reddb-io/dev": minor
"@reddb-io/redskilled": minor
---

Decouple the statusline by data ownership (ADR 0141, Spec #3561). The Statusline Bedrock — model·effort, context, subscription windows, repo/branch/diff, bundle version — renders zero-network on every invocation, with local git facts under their own ~5s micro-TTL. Every remote counter (`prs=`, `iss=`, `rdy=`, `hmn=`) moves into the redskilled daemon's presence-driven repository-activity poll (~15–30s while a session is registered, backed off idle, under the budget-aware GitHub client) and ships in the statusline payload with per-counter ages; the local 15-minute `gh` count caches are deleted. A request never fetches: MCP and statusline reads always serve from the daemon's cache with age stated. The statusline↔daemon relationship becomes a visible lifecycle — `bedrock-only`, `connecting`, `registering`, `unregistered`, `live`, `degraded` — rendered as a compact `rsk=<state>` token in place of the tail when not live, with a hard ~150ms socket deadline serving the last-known tail with its age so the prompt never freezes. Castle MCP counter surfaces answer from the same daemon payload.
