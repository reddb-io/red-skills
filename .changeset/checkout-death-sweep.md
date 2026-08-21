---
"@reddb-io/dev": patch
---

The checkout sweeps hard Worker deaths instead of waiting for the next boot.
A classified death the daemon published — `sender_class`, `confidence`,
`exit_code`, `signal`, `memory_peak_bytes`, keyed by `worker_id` alone — is
joined to the claim marker that carries this host's prefix, and from there to
the Ticket only the checkout can name. The claim is conceded eagerly, the
terminal history row the requeue ordinal counts is appended, and the existing
`recoveryDecision` caps decide: a memory kill requeues with the ceiling raised
above the measured peak, or at the next model tier when no headroom is left; a
requested stop or a host teardown requeues plainly; an unattributed SIGKILL is
left to the staleness sweep, which stays as the backstop. Exhaustion parks with
the receipt quoted.
