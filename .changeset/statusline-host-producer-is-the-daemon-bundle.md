---
"@reddb-io/dev": patch
"@reddb-io/redskilled": patch
---

The statusline's ONE host producer is redeclared as the **redskilled bundle**,
resolved out of the daemon's own home. The published `statusLine` command globbed
`~/.cache/red-skills/bundles/dev-*.bundle.min.mjs` first and ran it — and ADR 0147
deleted the dev runtime, so `dev-3.21.0.bundle.min.mjs` is the last one that will
ever exist. Every machine that had warmed a copy kept resolving it: a 3.21.0-era
renderer reading v4 state lanes it cannot parse, frozen at that version, silent
about Workers, and exiting 0 the whole time — the failure wore the shape of a
working line. PR #4235 repointed the warm/fetch path onto the daemon bundle and
deliberately left the producer "a decision, not a bug fix". This is that decision.

The command now resolves
`ls -1 "$HOME"/.red/redskilled/bundles/redskilled-*.bundle.min.mjs | sort -V | tail -1`
and runs it once. That directory is chosen for a property no cache has: every
writer that points a systemd `ExecStart` at a bundle stabilizes a copy there
first (#3554), so it is the one copy on the machine that an npx GC, a `mise
prune` or a moved checkout cannot take away — exactly what a render path that may
do no network and no resolution work (ADR 0084) needs. Rules 1, 2 and 4 are
untouched: the command still ends in an explicit `; exit 0`, every published copy
is still swept byte-identical across the two canonical skill docs and their two
`packaging/pi/` mirrors, and a host where nothing answers the glob still PRINTS
the absence in the daemon's own sentence rather than rendering blank.

Rules 3 and 5 invert. Rule 3 held the glob against `bundleFileName`, the npm warm
path's namer; it now holds it against `redskilledStableBundleName` and
`redskilledStableBundleDir` — the daemon's own, reached through a new
`@reddb-io/redskilled/stable-bundle` export — and the render test provisions its
fake host by running the real `stabilizeRedskilledEntry` rather than writing a
literal, so renaming that directory or that filename fails in the guard instead of
on an operator's screen. Rule 5 rejected a `redskilled*` command as a
double-render fossil; it now rejects the `dev-*.bundle.min.mjs` glob and the
`afk.mjs` launcher behind it, in both the dev-side doctrine
(`statusline-command-doc.ts`) and the daemon-side sweep of shipped adapter
recipes. `--no-workers` stays rejected. A new case proves the flip end to end: a
provisioned host with a leftover `dev-3.21.0` bundle still on disk renders the
daemon line and never the frozen one.

`install-runtime-shim.sh` loses its `dev-*` bundle fallback outright rather than
being repointed — there is nothing to repoint it at, and resolving the last dev
bundle is how a shim runs 3.21.0-era code without saying so. It now falls through
to a message that names the deletion. `/red-doctor`'s statusline-drift finding
reads the daemon glob as canonical and both dev forms as findings, and the skill
docs note that a leftover `dev-*` bundle is now inert — nothing globs it, so it
costs only disk, and one `rm -f` reclaims it.
