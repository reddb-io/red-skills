---
"@reddb-io/red-skills": minor
---

Skills and agent instructions speak the four Working modes

`/afk` becomes register → drain → observe and `/go` becomes one `go_dispatch`
call, so no client boot phase reads the human's checkout — ADR 0144 makes that
state a forbidden input. Every `npx … red-skills-dev` instruction in the shipped
skills is replaced by the `rs_*` tool that owns the verb (ADR 0147 §1), and the
four Working modes — interactive, spec-driven, ad-hoc, ADR-editing — reach the
dev plugin's agent instructions and the repo's development-workflow section, so
an agent can tell which mode it is in instead of inferring it.

The token-efficient terminal section leaves with the rsp hooks it described.
