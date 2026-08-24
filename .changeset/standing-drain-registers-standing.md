---
"@reddb-io/dev": patch
---

A drain resolved from a project's `afk.standing` declaration now registers with standing intent, so the registration survives daemon self-upgrade restarts instead of lapsing as a five-minute lease; a declaration that cannot register (no owner/name repository) warns the operator instead of failing silently.
