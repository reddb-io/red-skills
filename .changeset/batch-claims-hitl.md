---
"@reddb-io/red-skills": minor
---

Castle-MCP E7 (#2369): `claim_status`/`claim_release` accept a batch `issues` array (response keyed per issue, per-issue errors) alongside the single-issue form, and the new `hitl_resolve` verb encodes one human decision on a parked issue atomically — `requeue` (concede claims + one ADR 0122 transition, consuming dangling req:* edges on human override), `retake` (same freeing transition routed to the no-agent landing lane), `park`, or `close` — always posting the rationale as the audit trail. Collapses the 10-round-trip unpark sequences into one call.
