---
"@reddb-io/red-skills": patch
---

The daemon can run a turn for a Worker nobody is watching

**A birth nobody speaks to does nothing.** Every client turn goes admission →
session → prompt; the demand loop births a process for each unit of queue
demand and never prompts it, which is why a registered, draining project
produced Workers and no work (Spec #4097).

This lands the half that had no home: `acp-demand-turn.ts` runs that same
admission and turn with no client on the other end — its own session map, its
own synthetic session id per turn, and a record where a notification would have
gone. It deliberately does not borrow a connection's session map: an unattended
turn living inside a client's would die when that client disconnected, which is
the one property a drain must not have.

A permission request with nobody to ask is **refused, and said out loud**: a
daemon that answered "approved" on an operator's behalf would grant, unattended,
exactly the reach an attached client is shown a dialog for. The Worker gets a
refusal it can park on for `/hitl`.

A registration may now carry an opaque `prompt` — expanded with the daemon's own
facts like the argv already is, blank refused as shape, absent meaning Workers
born and not spoken to, which is every registration that exists today.

Permission resolution moves to `acp-permission.ts` on the way past: three
answers and no fourth, and the control plane returns under its headroom target.

**Nothing calls the runner yet** — the demand-loop call site is the next slice
of #4100, so this changes no live behaviour.
