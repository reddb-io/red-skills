---
"@reddb-io/red-skills": minor
---

Crashloop circuit breaker (#2527, ADR 0122 amendment): the supervisor fingerprints every boot-sweep halt; three consecutive identical boot-death signatures trip the breaker — respawn is suppressed (supervisor + watchdog), the resident issue-state curator is invoked immediately for the implicated state, and a loud alert surfaces in the supervisor lane, monitor dashboard, and statusline (`⛔brk=N×`). A different signature or one successful boot resets the run.
