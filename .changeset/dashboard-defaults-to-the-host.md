---
"@reddb-io/red-skills": patch
---

The dashboard defaults to the host, and the daemon's own tests finally run in CI

Running `redskilled dashboard` scoped itself to the directory you happened to be
standing in, so a machine watching two projects showed one. The host is what the
command is for: it now answers for the whole machine by default, marks the
current directory's project rather than hiding the others, and takes `local` —
or `--mode local`, or a config entry — when a single project is what you want.
The default is the dashboard's own, so the statusline keeps `local`, which is
right for a one-line status bar.

While wiring that, `apps/redskilled` turned out to appear **nowhere** in the
workspace CI: the shard matrix runs `apps/dev`, and the package job names five
packages that do not include the daemon. The host authority's own test suite has
never run on a pull request. It runs now.
