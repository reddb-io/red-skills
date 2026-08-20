---
"@reddb-io/red-skills": patch
---

The Worker can write through the daemon it publishes through

The first drain that got a real Ticket handoff refused at the claim:

```
refused at claim: "Method not found": github_write
```

**A Worker holds no credential, so every write it needs is a request to the
daemon** (ADR 0144 §3) — and its connection served only `publish` and `land`.
The Ticket loop claims through the registry's `githubWrite`, which was bound on
the public control plane and nowhere a Worker could reach. One Worker every
fifteen seconds, each refusing at the same door.

The GitHub domain is now bound on the Worker's own connection, scoped to the
Project it was admitted for, for the same reason publication already is: the
socket is what says who is asking.

Beside it, one refusal that had gone too far: `status { scope: project }` came
back *"the Project control surface cannot express live_only"*. Read shaping —
`live_only`, `fields`, `worker` — is declared in the tool's own schema and the
MCP fills the defaults in; refusing those made the tool unusable while changing
nothing about what the control surface answers. They are accepted and ignored;
an argument that would change the ANSWER is still refused.
