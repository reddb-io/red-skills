---
"@reddb-io/red-skills": patch
---

The navigator MCP manifest entry is optional, and its absence is the shipped state

ADR 0147 §4 switched `navigator` off at the declaration while its code stays, and
#4010 landed that removal — but `validate-install-metadata.sh` still required the
entry, so every PR after it failed `validate-marketplace` with "navigator MCP
manifest must use the on-demand launcher". The launcher assertion survives
inverted rather than deleted: the launcher must still exist and be executable,
and a manifest that names the server must still reach it through that launcher.
Only the requirement that the entry be PRESENT is gone.
