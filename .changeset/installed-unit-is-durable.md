---
"@reddb-io/red-skills": patch
---

An installed daemon unit points somewhere durable

The operator-facing install runs through `npx`, which hands the daemon an entry
inside `~/.npm/_npx/<hash>/` — a directory npm prunes on its own schedule. The
installed unit named that path, so a pruned cache leaves a daemon that cannot
start, discovered after a reboot when nobody is watching.

The stabilizer that copies such a bundle into `~/.red/redskilled/bundles/`
already existed. What it lacked was the one argument that lets it name a
destination: the version. It infers one from the bundle's filename, and an npx
dispatch always delivers the UNVERSIONED asset name, so it declined every time
and the raw cache path flowed into `ExecStart`. Both install paths now state the
version from the build stamp they already read.

A genuinely unversioned local build is still used as resolved. Durability is an
upgrade, never a precondition — copying a developer's own daemon out from under
them mid-session would be the worse failure.
