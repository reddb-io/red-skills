---
"@reddb-io/red-skills": patch
---

The demand loop prompts the Worker it births

The last wire of #4100. A project whose registration states a prompt now gets
the daemon's own unattended turn — admission, session and prompt, exactly as an
attached client would drive it — instead of a process nobody speaks to.

The turn is **not awaited**: it is the Worker's whole life, and a demand tick
that blocked on one would stop planning for every other project on the host. A
turn that fails records the reason on the host event lane, where a stall is
already read. A prompt naming a fact this birth does not have is refused before
anything is spawned, and a project that states no prompt births exactly as it
always did.

`demandTurnForBirth` holds that decision as a pure function, because the
interesting part is not the plumbing — it is which births change and which do
not.
