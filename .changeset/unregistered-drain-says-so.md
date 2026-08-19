---
"@reddb-io/red-skills": patch
---

A drain that cannot drain says so

Drain intent lives on the Project control record; the demand loop births only
for a REGISTRATION, which names the work query and the argv a Worker launches
with. A project that is `draining` with no registration therefore polls no
queue and births no Worker — and reported that as *"the daemon has not observed
this Project queue"*, which reads like a freshness lag that will clear on its
own. It never clears: nothing is going to observe it.

The dead end now announces itself in both places a caller can be standing: on
the `drain` answer itself (`warning`), because someone who ran drain and got a
clean answer has every reason to expect Workers; and in status, where
`queue.registered` states plainly whether the thing the demand loop polls
exists at all. The wording is declared once so the two accounts cannot drift.
