---
"@reddb-io/red-skills": patch
---

`drain` builds the registration it carries

#4101 taught the daemon to accept a registration on a drain and taught the
adapter to carry one — and nothing built it. Called from a session, `rs_dev`'s
`drain` still reached the daemon with a target and a runner and no work, so the
daemon recorded the intent and answered with the warning that nobody would act
on it. Verified on a live machine: `registered: false` after a successful
`drain`.

The MCP server now builds it. That is the right place: this process is the one
that knows what the project's work IS — which repository the checkout is, where
it stands, which version a birth should reach for — while the tool stays a
schema and `buildDrainRegistration` stays pure.

**Absent is a real answer.** A directory with no `owner/name` cannot state a
tracker query, and inventing an owner would register a project the daemon then
polls for nothing; the drain still records its intent and the daemon still says
nobody will act on it, which is the truth.
