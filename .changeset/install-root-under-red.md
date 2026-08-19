---
"@reddb-io/red-skills": minor
---

The installed tree moves from `~/.red-skills` to `~/.red/skills`

Everything RedSkills owns on an operator's machine already lived under `~/.red/`
— the daemon home at `~/.red/redskilled/`, brain at `~/.red/brain`, memory at
`~/.red/memory/<project-id>`, the disposable Worker evidence lane at
`~/.red/tmp/`. The installed version tree was the one holdout from before that
shape existed, and a second top-level directory is a second place to look when
something is missing.

`RED_SKILLS_INSTALL_ROOT` still overrides it. A machine carrying the old
directory is not broken: nothing reads it any more, so the launcher resolves
through npm exactly as it does on a fresh machine (ADR 0091), and the stale tree
can be deleted at leisure.
