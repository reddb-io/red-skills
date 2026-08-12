---
"@reddb-io/github": patch
"@reddb-io/red-skills": patch
"@reddb-io/redskilled": patch
---

The quota wait aims at the pool's reset instead of doubling blindly, every GitHub call carries a deadline, and the budget gate defaults off.

A rate-limited read used to sleep on a blind 60s→600s doubling ladder under a
30-minute cap — the aimed one-probe-per-wait the backoff promised was never
installed in production, so a pool that reset in sixty seconds froze queue
reads, workers, and MCP tools for up to fifteen minutes with no record on any
surface.

- The reset probe is installed: a rate-limit wait sleeps until the pool
  actually refills, and the doubling ladder is only the fallback it was meant
  to be.
- Every GitHub call the client issues — reads, writes, and the balance ask —
  now rides a shared deadline; a stalled connection becomes a loud bounded
  error instead of a silent epoll sleep.
- The budget gate defaults OFF: the quota belongs to the operator, so nothing
  is refused, deferred, or held on balance posture, and the read path never
  asks for the balance at all. Telemetry (balance history, spend ledger,
  rate-limit reporting) records in both modes. Opt in with
  `github.budget_gate: on` in the repository's or the host's
  `.red/config.yaml`, or `RED_GITHUB_BUDGET_GATE` for one run; the
  `/redskilled` skill documents the key.
- One failed spend-ledger write no longer poisons every later record for the
  life of the process, and the single-object flush can no longer strand its
  queue.
