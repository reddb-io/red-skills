# 0108 — AFK trunk freshness uses a fleet-owned red-trunk mirror

## Status

Accepted. Implements Trunk-freshness S2 from Spec #2071 and refines ADR 0083's
Trunk and untouchable-primary invariants.

## Context

ADR 0083 moved AFK away from hardcoded `main`: base resolution is
lock > pinned branch > configured Trunk, and consumers should read the resolved
base as a fresh remote-tracking ref. A later ADR 0083 amendment allowed one
guarded primary-checkout fast-forward after landing so worker births would not
fork from a stale local base.

That carve-out fixed stale births but kept the fleet coupled to the primary
checkout's current branch and cleanliness. It also left two different freshness
authorities in play: worktree births read `origin/<base>`, while post-land
promotion tried to advance the primary's local branch. A dirty primary, a human
on another branch, or a local divergence could still affect autonomous flow even
though the fleet's state is remote-first.

## Decision

AFK owns a dedicated local mirror ref named `red-trunk`
(`refs/heads/red-trunk`). The mirror is maintained in lockstep with the freshly
fetched `origin/<resolved-base>` tip and becomes the concrete start point for
worker branch creation.

The state machine is:

1. Resolve the semantic base by the existing precedence from ADR 0031 and ADR
   0083: branch lock, then issue/spec pin, then configured Trunk.
2. Fetch `origin/<base>`.
3. Update `refs/heads/red-trunk` to the fetched remote tip with `git update-ref`.
   If `red-trunk` is behind, this is a pure fast-forward. If upstream history was
   rewritten, reset the mirror to the new remote tip because the mirror is never
   checked out and carries no unique commits.
4. Pass `red-trunk` as the worktree birth base to red-castle's named-branch
   start point.
5. Land the worker branch to `origin/<base>` through the existing PR/direct
   landing paths and landing serialization from ADR 0071.
6. After a successful non-queued landing, fetch `origin/<base>` and update
   `refs/heads/red-trunk` to that tip. Native merge-queue entries skip promotion
   until the queue actually lands the PR, because the remote tip does not yet
   carry the work.

The primary checkout is no longer a freshness participant. AFK does not inspect
its HEAD, status, local trunk branch, or local divergence to decide worktree
birth or post-land promotion. The old guarded `fastForwardLocalTarget` helper may
remain for explicit operator repair/probe flows, but AFK landing no longer calls
it.

## Why

- A fleet-owned ref gives AFK a single mutable freshness object that is safe to
  update without checking out or merging into the maintainer's workspace.
- Worker births and post-land promotion now use the same ref discipline, so the
  next worker sees the just-landed remote tip even when the primary checkout is
  dirty or on another branch.
- Force-push handling becomes simple and deterministic: reset the mirror to the
  remote tip. There is no data loss because agents never commit to `red-trunk`.
- This preserves the semantic base model from ADR 0008 and ADR 0031 while
  replacing the local-primary freshness implementation that violated DD1.

## Consequences

- State records may show `current.base_ref: red-trunk` with
  `current.base_source: mirror`; `current.base` remains the semantic target
  branch.
- Tests at the base-resolution seam cover mirror creation, mirror fast-forward,
  and reset-on-history-rewrite through injected git execution.
- Tests at the landing seam cover PR/direct promotion via `update-ref` and
  assert that dirty or off-branch primary checkouts are not inspected.
- Operational probes that intentionally offer a human-confirmed primary
  fast-forward can keep using the old guard, but that is no longer part of AFK
  drainage.
