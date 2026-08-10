---
"@reddb-io/dev": patch
---

Stop two conditions in a shared checkout from killing Workers at boot.

A Worker branches from the fork SHA the host granted, never from the operator's local trunk, so uncommitted work in the primary checkout cannot affect it. Boot already exempted Worker sessions from a stale local trunk, but named only one of the two ways the guard reports uncommitted work: a dirty path that had also moved upstream fell through and halted the session. Three Workers died at boot in seventeen seconds over two dirty files on a branch none of them would touch, and the fourth failure opened the birth breaker for ten minutes.

The abandoned-index-lock reclaimer no longer robs a Git process mid-write. It judged a lock abandoned from two facts — zero bytes, and no live process holding it open — and a lock created microseconds earlier satisfies both, because Git creates it empty and has not yet opened it for writing. Deleting it killed the owner with `fatal: Could not write new index file`, an error naming no lock and therefore reaching no recovery. Reclamation now also requires the lock to be old enough that its owner cannot still be acquiring it, and the failure is recognised from both ends of the contention: the process that could not take the lock, and the process whose lock was taken.
