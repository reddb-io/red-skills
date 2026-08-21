---
"@reddb-io/redskilled": patch
---

A claude-code child authenticates as the operator, in a home of its own. The
first live claude-code drain was born, claimed its Ticket and worked — then
died on `Authentication required`: #4278 declared its unattended posture and
left its credential half undeclared, so the child ran with no login at all.
The credential homes are now one declared table (env var, operator file,
login command) covering codex and claude-code, seeded and re-seeded the same
way, and a host with no login is refused by name before a Worker is born.
