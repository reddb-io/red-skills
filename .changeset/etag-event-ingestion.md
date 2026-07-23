---
"@reddb-io/red-skills": minor
---

Event ingestion transport (#2514, Spec #2511 slice 3): the castle resident's webhook lane gains an ETag conditional-polling transport — `If-None-Match` reads where 304s are rate-limit-free, cadence honoring `X-Poll-Interval`, repo events deduped by id, and check-run snapshot diffing that emits exactly one `check.completed` delivery per transition for merge-driver-armed PR heads. The default resident transport is now a composite: the `gh webhook forward` child when its handshake holds, the poller as the always-armed fallback filling the same lane — consumers never see which transport delivered.
