---
"@reddb-io/red-skills": patch
---

The unattended turn opens the session it prompts in

The first real drain on 4.0.2 got all the way to the birth and stopped there.
The daemon polled, kept the identifier, planned the Worker — `depth: 1`,
`posture: asking`, `items: ["4118"]` — and then the host lane said:

```
the unattended turn for project "reddb-io/red-skills" failed:
unknown durable RedSkills ACP session
```

**A turn nobody opened is a turn the journal refuses.** Admission and every
checkpoint key off a durable session record, and the demand turn invented a
synthetic session id without opening one — so every unattended turn died at
admission, in a way no surface could explain from the outside.

It now opens its own session exactly as `session/new` opens a client's, before
admitting. Pinned by a test, because this failure is invisible in every
projection except the host event lane.
