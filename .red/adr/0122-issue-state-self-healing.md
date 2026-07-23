# Issue-state self-healing: heal the provable, quarantine the judgable, never halt the fleet

## Context

On 2026-07-22 a healthy 4-slot fleet crashlooped for ~20 minutes on a
three-issue poison chain. Two workers died leaving un-conceded `afk:claim`
markers (8 accumulated across generations); the claim-hygiene boot probe then
red-halted **every** subsequent worker boot, and each crashing worker minted
more incoherent state (park labels stacked on `ready-for-agent`, an active
`Current blocker` on a queued issue) — a self-deepening freeze. Every cure was
manual: a human ran `claim_release`, edited labels, archived blockers.

The failure had three independent roots:

1. **Ghosts at the source** — nothing guarantees a dying worker's claim is
   conceded.
2. **Multi-writer state** — many code paths (and humans) write issue labels
   directly, so contradictory label sets are constructible at all.
3. **Probe posture** — boot probes treat ONE bad issue as a reason to halt the
   whole fleet, and prescribe a fix no automated actor ever performs.

## Decision

Seven maintainer-resolved rules (grilling session, 2026-07-22):

1. **Probe posture: heal the provable, quarantine the judgable.** A boot/tick
   probe that can *prove* a defect mechanically (a claim marker owned by this
   machine whose worker pid is dead) heals it in place (posts the concede). A
   defect that requires judgment (contradictory state labels, an active
   blocker on a queued issue) sends **that issue alone** to quarantine. The
   fleet always keeps booting on the rest of the queue. Global halts are
   reserved for repo-level corruption, never per-issue state.
2. **Quarantine = label `quarantine` + removal of `ready-for-agent`**, with the
   probe's diagnosis appended to the issue body. Selection machinery needs no
   new rules — a quarantined issue simply is not `ready-for-agent`.
3. **Exit is curator-first, human-second.** A periodic curator re-runs the same
   coherence test over quarantined issues; if the incoherence has dissolved
   (dependency merged, claim conceded, labels fixed) it restores
   `ready-for-agent` autonomously. Issues still incoherent after N re-checks
   park for `/hitl`.
4. **Claims: concede-on-reap + TTL backstop.** The supervisor/watchdog posts
   the concede in the same act as reaping a dead worker (it already knows
   issue + worker + pid). Independently, claim markers carry a heartbeat and
   every reader treats a claim un-renewed for the TTL as expired — so even a
   dead supervisor cannot strand a claim forever.
5. **State transitions get a single owner.** Engine code changes issue state
   only through one transition API that applies label sets atomically (adding
   a park label removes `ready-for-agent` in the same call) and refuses
   violations of the one-state-role invariant. Direct `gh issue edit` writes
   from engine code are a defect. Human/manual writes remain possible; the
   curator is the belt for them.
6. **Heal budget per issue.** A ledger under `.red/state/` counts heals; the
   third heal of the same issue within 24h stops healing and quarantines the
   issue with the heal history as diagnosis — repeated mechanical healing of
   one issue is a signal, not a routine.
7. **The healer/curator lives in the castle resident** (not the supervisor
   tick), so it cures the queue even with no fleet running, and it is
   **event-driven with periodic reconciliation**: react immediately to the
   relevant event (worker death, label change, PR merge) via the #2514 event
   stream when it lands; until then, and as the permanent gap-filler, a slow
   reconciliation sweep does the same checks.

## Consequences

- The 2026-07-22 freeze class becomes a few seconds of self-heal (concede on
  reap; at worst one respawn cycle), not an operator incident.
- Quarantine makes poisoned issues *visible work items* with diagnoses instead
  of fleet-wide outages.
- The heal ledger converts "the janitor keeps fixing it" into an escalation
  signal.
- TTL semantics change what a claim means for every reader; readers must be
  updated together (single slice), and the TTL must comfortably exceed the
  longest legitimate heartbeat gap (gate runs).
- Until the transition API fully replaces direct label writes, incoherence
  remains constructible — the curator is load-bearing, not optional.
