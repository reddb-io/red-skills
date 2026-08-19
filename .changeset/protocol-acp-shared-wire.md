---
"@reddb-io/protocol-acp": minor
"@reddb-io/redskilled": patch
"@reddb-io/dev": patch
---
The shared RedSkills ACP wire moves into one package, `@reddb-io/protocol-acp`:
ACP v1/v2 compat and draft-revision gating, the RedSkills wire major, the local
Unix-socket / Named Pipe transport, and the `_redskills/*` method registry. The
daemon and the stateless adapters import it instead of carrying private copies,
and a grep-pinned ownership guard refuses a re-grown copy.
