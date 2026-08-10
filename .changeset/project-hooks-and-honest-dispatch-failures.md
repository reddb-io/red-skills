---
"@reddb-io/dev": patch
---

Let a project register hooks the daemon calls when its Workers are born and die, and stop three dispatch failures from naming causes nobody verified.

A project may now declare hooks inside its registration: the daemon runs them through ordinary admission, charged to that project's budget and recorded on the host event lane, so a hook is a birth the host judged rather than a stray process. Asynchronous hooks fire and are never waited for — a hook that throws or hangs changes nothing about the work. A synchronous hook carries a mandatory deadline and a declared wait, because the daemon is one process per machine and an unbounded hook would stall Worker birth for every project on the host.

Three failures now report what happened. A Worker the host granted and then refused at boot is attributed as a boot refusal instead of an unreachable daemon, so no failure path recommends stopping a healthy singleton. A targeted dispatch resolves its issue by number rather than through the queue search, so a Worker no longer refuses over an issue the dispatch just created. And a boot diagnosis is retained under a bounded budget, so the pointer in the closing comment reaches something a reader can open.
