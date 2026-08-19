---
"@reddb-io/red-skills": patch
---

The daemon holds the one brain; `rs_brain` is a thin MCP over it

ADR 0152's other half. `redskilled` now opens the host brain at `~/.red/brain`
once per machine and serves every `brain_*` tool over the new `_redskills/brain_call`
method, so two sessions on one host share one store handle instead of opening one
each. The handle is created above the connection loop and cached as a promise, so
a concurrent second caller joins the first open rather than starting a second.

`rs_brain` becomes what ADR 0147 rule 2 asks a Plugin MCP to be: it publishes the
tool schemas — so `tools/list` answers without a daemon — and forwards every call.
Its bundle now carries no RedDB, no connection string, no root resolution and no
channel bridge; the adapter contributes only the one fact the daemon cannot know,
the directory a capture came from.

The brain store engine moved to `@reddb-io/brain-store`, shared by the `brain` CLI
and the daemon, because the alternative was a workspace dependency cycle between
the plugin app and the daemon it forwards to.

Also fixed: the host root resolved to `~/.red`, which put the store at
`~/.red/.red/brain` — one level below where ADR 0152 put it, and one level below
where every other Brain root in the module resolves.
