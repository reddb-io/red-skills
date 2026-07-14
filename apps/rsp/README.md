# @reddb-io/rsp

`rsp` is the RedSkills command-output reducer for agent terminal work. It wraps
high-noise commands, emits compact decision-preserving output, and keeps the
original bytes recoverable through `el:<id>` handles.

Benchmark headline: `rsp` reaches **99.4% decision-oracle capture** versus
**RTK 4.9%** and **Headroom 0.6%** on the two-axis benchmark. The checked-in
summary is at [bench/results/rsp-two-axis.md](bench/results/rsp-two-axis.md),
and the benchmark guide is at [bench/README.md](bench/README.md).

## What rsp Does

`rsp` is both an explicit CLI and a hook target:

- `rsp git status`, `rsp git diff`, `rsp git log`, `rsp git show`,
  `rsp git blame`, `rsp git branch -av`, `rsp git commit`, and `rsp git push`
  render git output as compact TOON when that keeps the decision signal.
- `rsp gh pr|issue|run list|view` keeps GitHub rows, bodies, and failure states
  readable while avoiding repetitive raw payloads.
- `rsp vitest run` and `rsp cargo test` keep exit code, summary, and failing
  rows instead of streaming full green-suite logs.
- `rsp cat <file>` and `rsp cat --head N|--tail N <file>` provide bounded file
  reads. Code files include a symbol outline plus head/tail context; binary
  files pass through unchanged.
- `rsp exec -- "<command>"` runs a shell command, summarizes structured or large
  stdout, and preserves the command's stderr and exit status.
- `rsp wait ...` standardizes long waits for commands, GitHub PRs, workflow
  runs, and releases without handwritten polling loops.
- `rsp show el:<id>` writes the original bytes for an elided handle.
- `rsp`, `rsp stats`, and `rsp gains` report elision-store and telemetry gains.
- `rsp mcp` exposes the resident-backed compression surface for MCP clients.
- `rsp hook claude-pre-exec` and `rsp hook claude-post-exec` are the hook interception
  surfaces used by supported agent hosts.

The generated ambient instruction that agents read is
[generated/AMBIENT-SKILL.md](generated/AMBIENT-SKILL.md). Regenerate it after
wrapper capability changes with:

```sh
pnpm --filter @reddb-io/rsp gen:ambient-skill
```

## Recovery Model

When `rsp` omits bytes, it prints an `el:<id>` handle. Handles are short,
content-addressed identifiers minted by `RspElisionStore.mint(original, meta)`.
The resident writes recoverable storage into the rsp-owned RedDB KV collection
and records the command, loss level, creation time, expiry time, and byte count.
Ephemeral outputs keep bytes as compressed content-hash blobs, so identical
outputs share one stored blob while `rsp show` still returns the exact original
bytes.

Recover a handle with:

```sh
rsp show el:<id>
```

Expired or evicted handles print an expiry line with the original command to
rerun. Defaults are seven days of derivable/re-executable elision retention,
six hours of ephemeral retention, and a 64 MiB byte budget; `.red/config.yaml`
can override `rsp.ttlDays`, `rsp.ephemeralTtlHours`, and `rsp.byteBudget`.

## Resident and Telemetry

`rsp` uses a resident process so wrappers do not repeatedly open the embedded
RedDB store. Clients talk to the resident over a local socket. The resident owns
the single embedded writer, serves mint/get/stats/gains requests, drains
telemetry from a spool into RedDB, writes a statusline summary, and exits after
an idle timeout.

The full lifecycle is documented in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
That document covers the socket protocol, PID registry, version handover,
idle shutdown watchdog, telemetry spool and drain path, gains report, elision
store, wait registry, and the fail-open invariant.

## Configuration

`rsp` is enabled per repository with `.red/config.yaml`:

```yaml
rsp:
  enabled: true
```

Useful optional keys:

- `rsp.ttlDays`: elision handle retention days.
- `rsp.ephemeralTtlHours`: ephemeral byte-blob retention hours.
- `rsp.byteBudget`: elision byte budget.
- `rsp.telemetryTtlDays`: telemetry retention days.
- `rsp.telemetryByteBudget`: telemetry byte budget.
- `rsp.telemetryDrainIntervalMs`: resident drain interval.
- `rsp.telemetryDrainTimeoutMs`: per-drain timeout.
- `rsp.idleMs`: resident idle timeout, with a five-second minimum.
- `rsp.heavyGitByteThreshold`: threshold for large git/file/exec output.

If `rsp.enabled` is absent or false, wrapper commands pass through or report
that rsp is disabled. If a wrapper or resident path fails, `rsp` degrades to the
raw command whenever it can, preserving stdout, stderr, and exit status.
