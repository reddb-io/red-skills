---
"@reddb-io/shared": patch
"@reddb-io/redskilled": patch
"@reddb-io/dev": patch
---

The daemon reads the systemd unit receipt as facts instead of rendering it as
prose. A dead Worker's receipt already carried an exit code, a signal, a
systemd result and a memory peak onto the worker-death record; who ENDED the
Worker was judged once, far downstream, to paint a statusline, so a recovery
policy that wanted it had to parse a sentence. `resolveUnitDeath` now
classifies the receipt where it reads it — `sender_class` and `confidence` from
the existing attribution vocabulary, no new members — and both ride the record
keyed by `worker_id` alone. A cgroup OOM reads as `oomd`/`high` beside the peak
that names the bump an OOM retry needs; a requested stop reads as
`user-signal`; a stop the unit's own manager forced reads as `teardown`; and a
SIGKILL systemd did not attribute stays `unknown` at `low` confidence, because
that is the shape a kernel OOM wears on a host with no oomd integration and
naming a person there would be a guess. The statusline stops deriving a second
verdict over the same receipt, the lane decoder refuses a class outside the
vocabulary, and a row written before the field existed decodes as unclassified
rather than as confident.

The boundary that makes this safe is now mechanical: a repo invariant sweeps
every death-evidence carrier under `apps/redskilled/src` — discovered by the
death vocabulary, so a new carrier inherits the obligation the moment it lands
— and fails on an issue number, a triage label or a tracker call. The daemon
emits facts; the join to a Ticket is the checkout's.

`observedWorkerDeath` is now named by a test, which takes it off the
complexity-coverage baseline entirely.
