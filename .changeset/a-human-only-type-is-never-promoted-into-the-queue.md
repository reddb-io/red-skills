---
"@reddb-io/red-skills": patch
---

An unblocked dependent carrying a **HUMAN-ONLY type** is now promoted to `ready-for-human` instead of the autonomous queue (#2966). The unblock sweep and the close cascade read exactly two things about a dependent — its `blocked:dependency` label and its `req:*` edges — and promoted every all-blockers-closed one to `ready-for-agent`. Nothing looked at what kind of Ticket it was, so closing two decision tickets handed four human decisions to agents, and an operator reading `queue_status` saw a healthy queue. On a decision-shaped map most dependents of a decision ticket are themselves decisions: this fired on the normal path, and would fire again on every resolution after.

The lane now follows the dependent's own type. `afk.labels.hitl_types` declares which type labels this repo treats as human-only, and **the names come from that list, never from a built-in one** — a repo whose decision tickets are called something else declares its own and inherits the same protection. The routing lives in the transition planner's `promote`, so every promote path inherits it at once: the boot and periodic unblock sweeps, the event-driven close cascade, the reconcile lane, and the castle's own tracker cascade. The `req:*` edges are consumed either way — the dependency wait genuinely ended; what the blockers closing means is that the *human* may now act, not that an agent may act for them.

The promotion is no longer silent either: the audit comment names the lane it routed to and the type that chose it, so a human can tell a sweep promotion from a hand-set label. A repo that declares no HUMAN-ONLY type is unchanged down to the comment text.
