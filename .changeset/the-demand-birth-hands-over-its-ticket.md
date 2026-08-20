---
"@reddb-io/red-skills": patch
---

The demand birth hands its Worker a Ticket, not a sentence

With #4121's narration in place, the first real drain finally said what it had
been doing all along:

```
unattended turn demand-turn-completed for project "reddb-io/red-skills"
  on item 4118 (worker VSob7Cr): no-workflow-outcome (end_turn)
```

A fresh Worker every fifteen seconds, each ending in under a second having done
nothing. **The Worker body enters its Ticket loop only through a handoff**
(`ticketHandoffFromMeta`); given a bare prompt it takes its third path — echo
the prompt, end the turn — which is exactly what the daemon was asking for.

So the daemon states the handoff the contract already describes: the Ticket
number and title, its labels, the trunk, the briefing, and the Worker's own id.
The poll keeps title and labels beside the identifiers it already kept (#4098),
carried and never read, and the project's registered prompt becomes the
`handoff` text — which is what it always was.

A handoff is stated only when every fact it requires is present: a Ticket with
an empty title or no trunk is one the Worker refuses, and **a refusal the
daemon could have avoided is a Worker born to fail.**
