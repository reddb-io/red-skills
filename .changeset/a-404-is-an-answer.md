---
"@reddb-io/github": patch
"@reddb-io/red-skills": patch
---

A 404 is an answer, not a failure: stop retrying absent resources

The routed client's `doNotRetry` list held 304, 403 and 429 — every status
whose meaning is "do not ask again" except the most common one. A 404 was
retried with exponential backoff, so asking for a file a repository does not
have cost four requests over 14 seconds instead of one answer.

The trust gate asks for CODEOWNERS at three recognised locations, per actor,
per candidate. In a repository with no CODEOWNERS that was 93 seconds of
backoff per candidate, and a boot listing 14 of them froze for ~22 minutes:
no child process, no log line, no socket, and `live=true` on every liveness
surface — the exact shape an orchestrator hang wears.

Two fixes, at the two layers that were wrong:

- `packages/github` no longer retries a 404. Issue point reads are strongly
  consistent by number, so nothing legitimate depended on re-asking; a caller
  that awaits eventual consistency must say so with its own bounded loop.
- The CODEOWNERS lookup is now resolved once per repository per process. The
  file is a repository fact, but it was being read per actor. A read that
  FAILED is never cached, so one blip cannot poison the trust signal.
