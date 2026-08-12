---
"@reddb-io/github": patch
"@reddb-io/red-skills": patch
---

Harden GitHub reads and Worker operations for the next patch release.

- Preserve every definitive GitHub response as a single request while leaving
  transient server and network failures retryable. CODEOWNERS is shared across
  one trust evaluation, then refreshed for the next evaluation so revoked or
  changed ownership is observed without a process restart.
- Keep read-after-write recovery where its context belongs: `/go` performs a
  targeted, bounded read-back of the Ticket it just created.
- Restage generated Pi packages after landing reconciliation, use the canonical
  statusline invocation, and keep the incumbent daemon alive until its successor
  completes the handoff.
- Make Worker progress easier to interpret with clearer phase, step, activity,
  and clock reporting.
