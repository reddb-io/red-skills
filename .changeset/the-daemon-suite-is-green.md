---
"@reddb-io/red-skills": patch
---

The daemon's own test suite runs in CI, and passes

`apps/redskilled` appeared nowhere in the workspace CI: the shard matrix runs
`apps/dev` and the package job named five packages that did not include the
daemon. The host authority — the only process allowed to birth a Worker — had an
859-test suite no pull request had ever run. Wiring it in was refused once
already, on evidence: eight tests failed on a clean runner, and a *different*
seventy-seven failed on a developer machine. A gate is not a gate until it is
green, so the suite was fixed first and the wiring follows it here.

The 77 were one bug wearing many faces. The sandbox pinned four PATHS — HOME,
the runtime dir, the machine dir, its own root — and unit discovery is not a
path: a booting daemon asks the user's systemd for `red-worker-*` units, and
systemd has never heard of HOME. So every sandboxed daemon adopted the
operator's live Workers and counted them against budgets the test had just
declared. The sandbox no longer sweeps by default, and the three suites whose
SUBJECT is the sweep ask for it back explicitly.

The rest were tests outliving the designs they described: POSIX placement
stopped being macOS-only when it became the fallback for a systemd-less Linux
host; a malformed lane row stopped being fatal when #3651 showed what fatal
costs (one row an older daemon wrote took every `worker_dispatch` on the machine
down, reported as "the daemon did not answer"); a held daemon became retryable,
so a test that declared no patience inherited the 30s product default and raced
its own 30s timeout; and the successor is now staged while the incumbent still
holds the socket, so the spawn is no longer the moment the socket goes quiet.

One was a teardown that removed a directory out from under a live process — the
successor is spawned by the daemon under test, so it is the one child the suite
never holds a handle to.
