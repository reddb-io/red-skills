---
"@reddb-io/dev": minor
---

Daemon lifecycle fixes and the complete Release-standard engine (ADR 0139).

- `redskilled stop` now exits the process it reports stopping: the lease is
  released with the socket, a successor binds without an operator SIGKILL, and
  the `serve` exit boundary reads the sliced argv instead of walking
  `process.argv`.
- The daemon's user unit survives self-shutdown: operator-requested stop is the
  only clean exit, so `Restart=on-failure` covers every self-recycle, and an
  enabled-but-dead unit is now a provisioning finding instead of silence.
- Queryable daemon log: every worker event carries a required `kind`
  discriminator (with `event` as its legacy alias) plus admission, phase,
  base-drift and heal columns, with documented `tq` recipes.
- Fork grant end-to-end: the daemon owns the trunk fetch, the grant names the
  fork SHA, an unreachable trunk remote refuses birth, and base movement is
  stamped per live Worker on every surface.
- Release-standard engine (ADR 0139), all slices: changeset queue parser and
  status verb, version surfaces with drift refusal, release notes +
  JSON-and-TOON release-manifest assets, idempotent tag + Release publication,
  Version-PR maintainer with auto trigger, RC graduation, thin least-privilege
  workflows, vendored single-file execution mode, and the `/red-setup` release
  interview with the `release.*` config contract.
- `/redskilled <issue>` debug dossier: a self-serve handoff file resolving a
  worker by issue with fiche, event sequence, log excerpts and diagnosis.
- Statusline repaint over the published brand tokens package, held by the
  truecolor-extinction ratchet.
- 4-way sharded `test` job in workspace CI.
