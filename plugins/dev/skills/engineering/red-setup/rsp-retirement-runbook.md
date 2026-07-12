# rsp Retirement Operator Runbook

RTK is retired for live RedSkills guidance after the measured parity decision in #1420. This runbook documents the operator-owned machine cleanup. Repository code must not execute these steps automatically.

## Scope

- Live guidance should point at `rsp` wrappers, loss levels, `rsp show`, and the per-repo hook opt-in.
- Historical ADRs, issue threads, benchmark fixtures, and memory artifacts are history and should not be rewritten only to remove older names.
- The ambient host-instruction replacement for per-host RTK.md files is tracked in #1415. Treat it as the follow-up deliverable that ships the generated `apps/rsp/generated/AMBIENT-SKILL.md` surface to each host.

## Remove the Pre-Execution Hook

Inspect each agent's local settings and remove the RTK pre-execution hook entry. The exact file is host-specific, but the intent is the same: delete only the hook command that invokes the retired binary and keep unrelated hooks intact.

After editing settings, open a fresh agent session and confirm routine commands are no longer rewritten by the retired hook. In repos that opt in with `rsp.enabled: true`, the RedSkills hook may still rewrite simple supported commands to `rsp`; that is expected.

## Delete the Binary

Remove the retired binary from the operator-managed bin directory or package manager that installed it. Verify that the shell no longer resolves it:

```bash
command -v rtk
```

If another unrelated tool with the same executable name remains on `PATH`, leave that tool alone and document the distinction in local operator notes rather than changing repo guidance.

## Telemetry Database Retention

The old telemetry database includes a parse-failure ledger with forensic value. Keeping it, archiving it, or deleting it is an operator decision:

- **Keep** when recent failures may still inform `rsp` parity audits or incident review.
- **Archive** when the ledger is no longer active but may be needed for provenance.
- **Delete** only when local retention policy says the forensic value has expired.

Do not migrate this ledger into repo state. `rsp` stores current reversible elisions in the repo RedDB store under its own collection; the retired telemetry database remains a machine-local artifact.
