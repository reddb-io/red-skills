# AFK arms the attempt progress guard + heartbeat under docker/podman isolation

## Context

ADR 0044 (attempt progress guard) and ADR 0045 (externalized proof-of-life
heartbeat) both armed **only under no-sandbox isolation**. Their stated reason:
under docker/podman the inner agent commits in an isolated copy not host-visible
until final sync, so a commit-anchored progress probe would false-fire and park a
healthy agent. So container runs got the idle timeout + `maxIterations` but no
progress guard and no periodic heartbeat — the two failure classes those ADRs
close (the "productive infinite loop" and a blind monitor) were unguarded under
the very isolation mode meant for untrusted work.

Two facts reopened the decision:

1. **The premise was version-stale.** `@ai-hero/sandcastle` ≥ 0.6.x implements
   its `docker()` / `podman()` providers as **bind-mount** sandboxes, not
   copy-isolated ones. The worktree is host-created (`git worktree add` runs on
   the host), then the worktree **and** the shared `.git` are bind-mounted into
   the container at identical paths. So the worker branch's commits land in the
   host-visible shared `.git`, and worktree edits land in the host-visible
   worktree — both observable mid-run by the same host git probes the guard
   already uses (`branchHead`, worktree diffstat). The "isolated copy, final sync
   only" description matched sandcastle's *isolated* provider tag, not the
   bind-mount docker/podman providers.

2. **HITL decision (2026-06-08):** bind-mount the attempt directory into the
   container and arm the guard off the host-visible proof-of-life lane under
   isolation, rather than skipping it.

## Decision

Arm the attempt progress guard (ADR 0044) and the externalized heartbeat
(ADR 0045) for **every** sandbox mode, gated only on the presence of a worker
branch — no longer on `sandbox === "none"`.

1. **Bind-mount the attempt dir (issue #405).** `buildRunOptions` forwards the
   host attempt dir (`input.cwd`, `.red/tmp/workers/{id}/{N}-a{n}/`) to
   `sandboxFor` as `{ mountPath }`. Under docker/podman the provider adds it as a
   bind mount at the **identical** host→sandbox path, so the proof-of-life lane
   (`afk.state.json`, `agent.log.jsonl`, `log.jsonl`) and the worktree sandcastle
   creates under it are host-visible in real time. The identity path keeps host
   probes resolving the same locations the agent writes. `none` ignores it.

2. **Decouple lane-idle from the progress guard.** `resolveAttemptGuardArming`
   (pure, in `runtime/wire.ts`) returns `{ guardArmed, laneArmed }`:
   `guardArmed = !!branch` (all modes); `laneArmed = sandbox === "none" && …`.
   The lane-idle stall reaper (issue #363) stays **no-sandbox only**: its
   busy-predicate inspects the *host* process tree, which cannot see the inner
   agent inside a container — under isolation it would read every container as
   "not busy" and could reap a genuinely-busy worker. Arming the guard under
   isolation must not drag the host-blind reaper along, hence the split.

3. **The heartbeat rides the guard's tick unchanged.** Because the guard now arms
   under isolation, its `onTick` → `onHeartbeat` chain (firehose `type=heartbeat`
   record + `current.last_progress_at` state field + the periodic `on_heartbeat`
   hook) fires under docker/podman too. No second loop, no new cadence.

## Consequences

- The progress guard and periodic heartbeat now protect container runs identically
  to no-sandbox runs; the only isolation-specific gap left is the lane-idle reaper
  (documented, by design).
- `SandcastleDeps.sandboxFor` gains an optional `{ mountPath }` arg; the real
  wiring maps it to the provider `mounts` option. Back-compatible — callers/tests
  that pass a 1-arg `sandboxFor` still satisfy the type.
- Absorbs #284's residual docker AC: the `afk.sandbox: docker` execution path now
  has an end-to-end gate (the docker-mode assertions in
  `scripts/afk-e2e-smoke.sh`) on top of the bind-mount unit coverage.
- Coupling note: this leans on sandcastle's bind-mount docker/podman behavior. If
  a future sandcastle switches docker to a copy-isolated provider, the
  commit/volume probes go blind again and arming would need to revert per-mode —
  `resolveAttemptGuardArming` is the single switch.

## Status

Accepted; implemented (issue #405). Supersedes the "armed only under no-sandbox"
constraint in ADR 0044 §4 and ADR 0045 §4.

## Related

- ADR 0033 — AFK execution on sandcastle (the bind-mount providers this relies on).
- ADR 0044 — attempt progress guard (this lifts its no-sandbox-only constraint).
- ADR 0045 — externalized proof-of-life (this lifts its no-sandbox-only constraint).
- ADR 0051 — guard resets on worktree edits (the volume probe reused under isolation).
- Issue #284 — docker E2E (its residual AC absorbed here).
