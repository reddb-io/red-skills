# Issue Lifecycle State Machine

```
ready-for-agent
       │
   (claim)
       ▼
    running
   ┌───┴───┐
   │ inner agent: DONE | BLOCKED
   │
   ├── DONE + merged
   │       │
   │   (close)
   │       ▼
   │    closed
   │
   └── terminal failure
           │
       (classify)
       ├─ recoverable & under cap → add ready-for-agent
       └─ non-recoverable or at cap → add ready-for-human
```

Dependencies use `req:N` edge labels and `blocked:dependency` state. A dependent issue is promoted to `ready-for-agent` when all its `req:*` issues are closed (close cascade, then boot-time unblock sweep). Use `## Blocked by` for mechanical dependencies; use `## Current blocker` for gates/decisions/products that `ready-for-human` gates.
