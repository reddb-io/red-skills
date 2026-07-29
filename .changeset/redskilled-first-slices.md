---
"@reddb-io/dev": minor
---

First slices of the `redskilled` host-scoped execution daemon (Spec #2772, ADR 0130).

Every fleet is scoped to one directory, which is right for work and wrong for resources: each checkout reads the same host capability profile, concludes the machine affords N workers, and spends that budget alone. These slices lay the foundation for one daemon that owns Worker processes across every project on a machine, while each project's bundle keeps owning the work.

- **`redskilled` skeleton** (#2773) — a user-session singleton reachable over a unix socket, with lease ownership, auto-spawn, and an idle rule that never exits while a Worker is alive.
- **A Worker is born through the daemon** (#2774) — the daemon plans placement from injected probes and launches the Worker into a transient service unit of its own, so the resource charge lands at birth rather than being reassigned later.
- **Project identity resolves once** (#2778) — a declared `project.name` wins, then the git remote, then the checkout basename; the filesystem slug always carries a short hash of the git common directory, which makes a collision between independent clones impossible by construction while collapsing a repository's worktrees onto the project they belong to.
- **The Worker state file becomes TOON/TOONL** (#2783) — the state file stops violating the repository's own encoder mandate, and its entry leaves the JSON file-I/O allowlist.
