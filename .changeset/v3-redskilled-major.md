---
"@reddb-io/red-skills": major
---

**v3 — the `redskilled` host-scoped execution daemon owns Worker birth, and the Fleet and the Attempt are extinct.**

This is a breaking change to how work is executed, not a feature on top of the old model.

**One daemon per machine births every Worker.** A per-project runtime states an argv, a workspace and its own opaque project label, and asks the host; it holds no `spawn` of its own. The daemon admits against a host-wide budget, places each Worker in its own resource unit, samples RSS against a uniform floor every backend must clear, and records births and deaths on an append-only host event lane. A launch that cannot reach the daemon **refuses** rather than falling back — a Worker this process started itself is one no admission verdict judged, outside the host budget, absent from the event lane, reported by no surface (ADR 0130 rule 6).

**The Fleet is gone.** The named-fleet registry, its hooks, its `fleet_*` tools and the cross-host federated view are removed. Width is not a fleet's property; it is what the host's budget admits.

**The Attempt is gone.** The attempt record, its retention and its lane are removed, and liveness re-anchors onto the daemon's process truth rather than onto a per-attempt narrative. Resource accounting keys to the Worker, the unit that survived.

Both extinctions are enforced by a ratchet whose baseline only ever shrinks, and which fails on a module or symbol merely *named* for an extinct concept — not only on a reintroduced source.

**Also in this release:** every shipped binary answers `--version` off the build stamp and routes its arguments through the shared contract, enforced from the `bin` map so a new binary inherits the obligation; the Gemini CLI is a first-class projection of the Claude-side manifest; and a dispatched Worker adopts prior work already pushed on its issue's branch instead of starting over.

**Upgrading:** a machine carrying pre-cutover state runs the boot migration once. Workers in flight at cutover time have one defined outcome, and it is the documented one.
