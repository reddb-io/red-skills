---
name: guard-process-birth
description: Keeps Worker process birth behind the host-scoped redskilled daemon. Use when changing per-project runtime source under apps/dev/src.
paths:
  - "apps/dev/src/**/*.ts"
---

# Guard Process Birth

<what-to-do>

**Route every Worker birth through the host** — make the per-project runtime
state the argv, workspace, and opaque project label, then ask the `redskilled`
daemon through the birth port. Only the host-scoped daemon creates the Worker
process.

**Keep the boundary precise** — this invariant governs Workers, not the
project's own runtime process or helper processes such as an `rsp wait` child.
Put helper launches in a narrowly named runtime adapter so they cannot become a
second Worker-birth route.

**Fail closed when the daemon is unavailable** — return the structured repair
from the birth port. A local-spawn fallback bypasses host admission, budgets,
the host event lane, and every host-facing status surface.

**Extend the ratchet with the cutover** — when another per-project module stops
birthing Workers, add its path, former responsibility, and replacement route to
`HOST_OWNED_BIRTH_SITES`. Keep removed modules declared with `removed: true` so
a rename or resurrection stays observable.

**Finish at one host-owned route** — done means every Worker request in the
touched flow reaches the daemon birth port, no local fallback can create the
Worker, and `host-owns-birth-guard.test.ts` passes.

</what-to-do>

<supporting-info>

The executable inventory and actionable failure routes live in
`apps/dev/src/core/host-owns-birth-guard.ts`. ADR 0130 rules 2 and 6 own the
host-authority and fail-closed decisions.

</supporting-info>
