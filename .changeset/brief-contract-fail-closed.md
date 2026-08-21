---
"@reddb-io/protocol-acp": patch
"@reddb-io/worker": patch
"@reddb-io/dev": patch
---

The brief contract stops advising and starts refusing, at three doors.

The executable-acceptance lint has scored issue bodies since the triage skill was
written, and `/red-doctor` has reported on it — as a warning. A brief reading
"make the retry logic better" passed the doctor, reached `ready-for-agent`, was
claimed, and cost a Worker a whole workspace to discover that it names no
finishable task. The rule existed; nothing enforced it.

It now sits in `@reddb-io/shared/brief-contract.js`, where all three layers that
must obey it can reach it — a runtime, a wire and the engine — and each one says
no on its own:

- **Triage promotion.** `planBriefGatedTriageTransition` gates only the
  `ready-for-agent` decision, because that label is not a record of an opinion
  but a promise to the drain that a Worker can finish this issue from its body
  alone. A refusal routes back to `needs-triage` and plans the same idempotent
  recipe comment triage already knew how to render, carrying the lint's finding
  verbatim. `type:spec` is exempt: a Spec's Tickets carry the executable
  criteria, and demanding them of the document whose job is to decide what they
  should be is a rule eating its own tail.
- **The native handoff decoder.** `handoff` was already required to be non-empty,
  which only ever refused the empty string. `ticketHandoffFromMeta` now asks the
  brief the same question triage asks and answers `undefined` when it fails —
  unchanged in kind from how it refuses a missing `base`, and still never a
  throw, because the same Worker body serves ordinary prompt turns.
- **The Worker preflight.** The Ticket loop asks the brief immediately after the
  lane-to-mode refusal and before the claim marker exists. Withdrawing costs
  nothing; owning a Ticket nobody can finish costs the queue an entry until a
  sweep concedes it.

Mechanism imported from the pstack study (Spec #4129, ADR 0154); implementation
original to reddb.io.
