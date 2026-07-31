---
"@reddb-io/red-skills": patch
---

The **demand loop now runs inside the daemon** (#2907). The host decides *when* to ask for the next Worker, not only whether one may be born — the other half of ADR 0130 Amendment 4's two-player model, after the MCP stopped launching a process. Target resolution, the decision to ask and shortfall accounting moved to the one process that holds every project's registration and every project's live Worker at the same instant, closing the gap where a producer deferred to the host on *how many* Workers exist while independently deciding *when* to ask.

**The queue bounds the target.** A project is asked for `min(target, depth) - live` Workers: the registration states how wide it may go, the queue states how much work exists to go wide on, and the smaller of the two is the honest answer. The depths come from the poll that already batches every registered project into one aliased request, so a tick costs no request of its own. **A depth is never invented** — `0` means the queue drained, an absent depth means nobody counted it, and only the first of those is a project that has finished.

**A refusal is an outcome, never an error.** A tick that the host could only half-grant resolves, carrying the host's own sentence and the shortfall it produced, and then holds every project back for a window before asking again — re-asking into a full machine is exactly how a client turns a ceiling into a busy loop. The hold is host-wide because the ceiling that produced it is, and it is cleared by the first tick that asks and is not refused, so the room a dying Worker frees is spent on the next tick rather than on the timer.

A registration now carries a **workspace path** beside its opaque selector and argv, because the daemon births the Worker itself and a host that had to *derive* a working directory would have to know what a checkout looks like — the one thing ADR 0130 rule 3 forbids. A path it needs is a path it was given. Nothing in the loop branches on what a selector or an argv says. A daemon holding a registration no longer exits on idle, so a drain outlives the session that started it.
