---
"@reddb-io/red-skills": patch
---

A Worker waiting on the daemon has a deadline

Five Workers sat alive for eleven minutes each with nothing to show: worktree on
`main`, zero changes, an empty narration lane, no claim comment, and fifteen
seconds of CPU between them. Every liveness surface called them healthy.

They were waiting. A Worker holds no credential, so it claims, publishes and
lands by ASKING the daemon (ADR 0144 §3) — and those asks were unbounded
awaits. **An unbounded wait inside a Worker looks exactly like work**, which is
the orphan-poll shape this repository already refuses in its own engine
(`DECLARED_WAITS`) and had not refused in the Worker body.

Every request the Worker makes of the daemon now carries a deadline and names
the method when it passes, so a stall ends as `refused at claim: the daemon did
not answer github_write …` instead of a Worker that idles until someone kills
it. The bound is deliberately generous — a forge write behind a cold credential
is slow, not broken — and deliberately does NOT cover the child agent's own
turn, which is meant to be long.
