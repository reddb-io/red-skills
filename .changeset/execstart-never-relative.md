---
"@reddb-io/redskilled": patch
---

Never let the daemon's systemd unit die on a relative `ExecStart`. The in-major self-replacement's version-pinned dispatch wrote a bare `npx` into the supervisor drop-in, and systemd resolves `ExecStart` with the manager's PATH — 203/EXEC on every start where node comes from a version manager, until a manual `reset-failed`. The pinned dispatch now resolves `npx` to an absolute path through the daemon's own view (beside its node, then its PATH) and refuses the upgrade when it cannot; the unit repoint refuses any relative command before writing; and a supervised boot heals an already-poisoned drop-in for its own session with the running process's absolute invocation.
