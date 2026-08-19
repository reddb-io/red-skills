---
"@reddb-io/red-skills": patch
---

A registration whose launch cannot run is refused at registration

#4006 birthed 22 Workers from an argv that could not run, and a human found it
by reading a log — after the project's birth breaker latched. The daemon now
asks at registration instead: **every shipped binary answers `--version` offline
without a working machine**, which is exactly what makes it usable as a probe.
One process, no work, no side effect, and a truthful answer about whether the
thing the registration names exists at all.

Refusal is reserved for *nothing ran* — a spawn error, or the 126/127 a shell
gives for a command it could not find or execute. A binary that ran and disliked
a trailing `--version` still exists, and refusing that would be the probe
inventing a defect. A timeout or a permission error is **inconclusive**: a cold
npx cache is not a broken launch, and refusing on it would trade one silent
failure for a louder wrong one. The refusal names the canonical invocation form
(ADR 0091), so an operator reads the shape that works.

The probe is **off unless the host asks for it**: running a registration's argv
is the one place the daemon touches a string it otherwise only carries, so the
reach is granted by the entry that serves a real machine rather than assumed by
every daemon a test constructs.
