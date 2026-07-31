---
"@reddb-io/red-skills": patch
---

The project's MCP now **registers its project** instead of launching a process for it (#2902). This is the operator-facing half of ADR 0130 Amendment 4's two-player model — **the MCP registers, the daemon drives** — and after it, beginning work on a repository creates no process of the project's own. `project_start` hands the host a repository identity, an opaque selector, an opaque argv and a target width, and returns the record the daemon is keeping; `project_stop` gives that record back, so a project that stopped may register again.

**A daemon that does not answer refuses the start** (ADR 0130 rule 6), with the socket named in the refusal. There is deliberately no fallback to spawning a supervisor: a demand producer started that way is one no host admitted, no host counts and no host can stop — precisely the shape the registration exists to end. A **stop** that cannot reach the daemon reports it as a warning rather than raising, because refusing to stop would leave an operator holding a project they cannot put down, and the registration lapses on its own renewal deadline anyway.

The registration's argv is what runs when a Worker is born for this project, resolved from the **published** bundle exactly as a launch resolves it, so a registration made from a stale plugin cache never commits the host to an older Worker than the one this project publishes. The daemon gained one op to make the release possible — `project-deregister`, a project-write like every other statement about a project — and it widens the frozen contract by nothing: it names a project the daemon already keys registrations by, and reports whether a record stood rather than raising when none did.
