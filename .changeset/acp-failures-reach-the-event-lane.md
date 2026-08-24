---
"@reddb-io/redskilled": patch
---

Failures on the public ACP surface — a connection the daemon could not serve, a turn that died outside its answer path, and a turn that ended as a refusal — are now recorded on the host event lane as `acp-failure` events instead of being silently discarded; what the client is told does not change.
