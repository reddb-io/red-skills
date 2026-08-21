---
"@reddb-io/shared": patch
"@reddb-io/redskilled-render": patch
"@reddb-io/redskilled": patch
"@reddb-io/dev": patch
---

Restore the Statusline Bedrock on the producer that survived.

ADR 0147 deleted the dev bundle that owned the Bedrock, and PR #4272 pointed the
host's `statusLine.command` at the `redskilled` bundle — which rendered only the
daemon tail, so the operator's bar lost model, directory, branch, context and the
subscription windows, and piping a Claude Code payload into it changed nothing.

The pure render, the stdin-payload parse and the local-git micro-TTL move DOWN to
`@reddb-io/shared` and the paint to `@reddb-io/redskilled-render`, because the
daemon may not import a runtime (dependency-direction guard #4135). The daemon's
`statusline` command now reads the host payload under a hard deadline and renders
`<bedrock> · <tail>` in one process — the permanent seam ADR 0141 §1 describes.
Absent, malformed or never-closed stdin costs the payload blocks and nothing
else: the line still carries the facts the machine itself holds.
