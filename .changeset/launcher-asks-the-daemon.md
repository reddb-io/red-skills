---
"@reddb-io/red-skills": patch
---

The launcher asks the daemon which version to run

ADR 0151 gives `redskilled` ownership of the version that runs on a machine, and
this is the consumer half: the daemon writes `~/.red/redskilled/served-version.toon`
on every boot, and the entrypoint launcher prefers it over resolving a bundle
from its own cache. That closes the shape where three caches decided
independently — one machine held 3.17.1 in its plugin cache, 3.18.12 in its npx
cache and 3.19.3 on main, a skew that surfaces inside a hook where nobody is
watching.

It is a file rather than a socket call on purpose: the launcher runs on the hook
path, and one that dialled the daemon would hang exactly when the daemon is the
broken thing. Every read failure answers `null`, so a machine with no daemon
falls back to its own resolved version, which is the right answer there. A pinned
`canary` channel still wins — an operator asking for canary is not asking what
the daemon serves.
