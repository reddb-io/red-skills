---
"@reddb-io/red-skills": patch
---

A drain registers the project it drains

**A drain intent nobody registered polls nothing.** The demand loop births for a
registration — the record carrying the query, the workspace, the argv and the
prompt — and nothing had authored one since #4031 deleted the engine that used
to. Every drain since recorded an intention and produced no Worker.

`project_drain` now accepts the work the caller carried and registers it through
the daemon's own registration path, sweep and breaker included, under the
project the connection is bound to — a caller cannot register work under
another project's name. The registration happens BEFORE the intent is written,
so a drain that could not register never records "draining".

The semantics are authored where they mean something: `buildDrainRegistration`
(`apps/plugin-dev`) turns a repo, a target and an optional selector into the
tracker query, its typed poll plan, a canonical pinned argv and the one-sentence
prompt a Worker carrying the dev skills needs. From the socket onward all of it
is opaque.

A drain that carries no work behaves exactly as before, warning and all.
