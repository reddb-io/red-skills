---
"@reddb-io/redskilled": patch
"@reddb-io/dev": patch
---

Split `acp-control-plane.ts` into compatibility-negotiation and socket-plumbing modules, restoring file-size headroom for the remaining ACP chain. Behavior unchanged.
