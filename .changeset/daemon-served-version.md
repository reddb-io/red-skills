---
"@reddb-io/red-skills": patch
---

The daemon announces the version it serves on the ACP handshake

ADR 0151 makes `redskilled` the owner of the version that runs on a machine. The
`initialize` response now carries `_meta.redskills.servedVersion` on both wires,
and `agentInfo.version` stops being the hardcoded `"1"`, so a launcher can ask
the daemon which version to run instead of resolving a bundle from its own cache
— the shape that let one machine hold 3.17.1, 3.18.12 and 3.19.3 at once. Read
fresh per handshake, so a handover is visible immediately. A differing minor
inside one wire major stays compatible by contract (ADR 0145 §3) and is not a
refusal.
