---
"@reddb-io/red-skills": patch
---

Worker/gate teardown no longer leaks orphaned vitest forks (#2432): every engine path that terminates a worker, gate, or wait kills the entire process group (setsid at spawn, TERM→grace→KILL on `-PGID`) and verifies descendants are gone, matching the rsp wait cleanup contract. The tmp-janitor sweep additionally detects orphaned test-runner processes (parent dead, cwd inside a `.red/tmp` workspace), reaps them by process group, and logs each kill.
