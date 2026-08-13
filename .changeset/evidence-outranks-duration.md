---
"@reddb-io/red-skills": patch
---

Structured branch evidence outranks duration in the failed-Validation Verdict

A suite-shaped command that exited in under a second was read as proof the
suite never started, and therefore as an environment failure. The inference is
invalid whenever turbo replays a cache hit: a cached task answers in
milliseconds precisely because it does not need to start. Real compiler errors,
failing assertions and guard findings came back in 26 and 45 milliseconds and
were stamped `suspect-infra`, so the Re-seed budget was spent on the wrong
repair and land-able work was parked into the human queue. Five parks in one day
carried that stamp; every one verified by hand was a deterministic contract
defect.

Duration no longer decides on its own. A round whose output names a concrete
compiler error, a failing assertion, or a guard finding is a BRANCH fault
however fast it returned; the environment verdict is reserved for rounds that
produced no such evidence.

The narrower half of the old rule went with it. Concrete evidence used to count
only when the diagnostic also named a file the branch had changed — so a real
type error inherited from a stale base did not qualify, which is exactly the
shape that misclassified. Evidence is now evidence regardless of which file it
points at.
