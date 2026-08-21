---
"@reddb-io/worker": patch
"@reddb-io/redskilled": patch
---

The Worker body kills the child Agent it spawned, and the process the child spawned.

Every dead codex Worker on 4.1.15/4.1.16 left its `codex-acp` pair alive — the `npx` wrapper and the platform binary under it — re-parented onto the systemd user manager, six pairs in one evening, each still holding an authenticated session (#4241). The kill the body already had aimed at the pid it held, and the pid it held was the wrapper: the grandchild survived it and outlived the transient unit. The child Agent is now spawned `detached`, so it leads a process group of its own, and `child-reaper.ts` owns that group's lifetime — a confirming SIGTERM→SIGKILL group reap on teardown, replacement and failed admission, plus a synchronous group SIGKILL at the process edge, where `SIGTERM` and `exit` have no turn of the event loop left to await one. `WorkflowChildAgent.close` is awaited rather than fired, because a teardown that only asked returns before the child has left.
