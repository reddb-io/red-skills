---
"@reddb-io/protocol-acp": minor
"@reddb-io/redskilled": minor
---

`_redskills/go_dispatch(demand)` lands on the daemon: one call mints the
disposable Ticket into the isolated go lane, admits a Worker against exactly
that Ticket, and answers with the Worker id. Its schema — params, answer and
the validator that refuses a caller-named lane, Ticket or budget — is published
from `@reddb-io/protocol-acp`.

The control plane's `_redskills/*` bindings become data. Each domain (host,
Project control, GitHub, credential budgets, go) declares its own bindings and
the fragment it advertises on `initialize`; one table composes them and both
ACP dialects register from it, replacing two hand-kept `.onRequest` chains and
two copies of the capability block. A layout test pins one module per domain.
