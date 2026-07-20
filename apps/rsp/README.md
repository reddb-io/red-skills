# @reddb-io/rsp

`rsp` is the RedSkills command-output reducer for agent terminal work. It wraps
high-noise commands, emits compact decision-preserving output, and keeps the
original bytes recoverable through `el:<id>` handles.

Benchmark headline: `rsp` reaches **99.8% decision-oracle capture** versus
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
- `rsp wait ...` is the standalone coordination primitive for commands, GitHub
  PRs, workflow runs, and releases. It emits a versioned TOON/JSON result that
  is durable before it wakes anyone, keeps the target verdict separate from the
  delivery receipt, bounds every command and GitHub probe by timeout and
  cancellation, and verifies that no descendant survives.
- `rsp show el:<id>` writes the original bytes for an elided handle.
- `rsp`, `rsp stats`, and `rsp gains` report elision-store and telemetry gains.
- `rsp mcp` exposes the resident-backed compression surface for MCP clients.
- `rsp hook claude-pre-exec`, `rsp hook claude-post-exec`, and
  `rsp hook codex-pre-exec` are the hook interception surfaces used by
  supported agent hosts.

## Permanent Proxy Model

The pre-exec hook has two modes after `rsp.enabled: true` is set. Without the
proxy flag it rewrites only the explicit wrapper families listed in the
generated ambient skill. With `rsp.proxy.enabled: true`, the hook rewrites the
whole eligible shell command to:

```sh
rsp proxy -- "<original command>"
```

The universal hook route has deliberate exclusions. It passes through empty or
missing commands, background jobs using a single `&`, recursive `rsp` calls,
known interactive commands such as shells, editors, pagers, `ssh`, and process
monitors, and commands opted out with `RSP_NO_PROXY=1` or
`RED_SKILLS_RSP_NO_PROXY=1`.

`rsp proxy` then makes a contribute-or-pass decision per recognized shell
segment. It contributes only for stdout-tail segments it can wrap without
changing upstream bytes:

- git `status`, `log`, `diff`, `show`, and `blame`
- GitHub `pr|issue|run list|view`
- `vitest`, `vitest run`, and `cargo test`
- simple `cat`, `head`, and `tail` file reads

Pipeline producers are not rewritten, so bytes inside pipes remain untouched.
GitHub commands using `--json` or `--jq` are a special lossless family: they are
recorded as `lossless-gh-json-jq` passes and execute byte-identically rather
than being summarized.

## Contribution Metrics

`rsp stats` reports decision telemetry from the dedicated decision lane:
`seen`, `contributed`, `passed`, `failed_open`, `contribution_rate`, and the top
pass reasons. A contributed decision means rsp inserted a wrapper. A passed
decision means the hook or proxy intentionally left the command or segment raw.
A failed-open decision means rsp hit an internal failure and ran the original
command instead.

Treat these metrics as the contract for what rsp actually changed. They can
substantiate proxy coverage, opt-outs, lossless GitHub JSON/JQ passes, and
fail-open behavior; they do not claim compression for unrecognized command
families.

The generated ambient instruction that agents read is
[generated/AMBIENT-SKILL.md](generated/AMBIENT-SKILL.md). Regenerate it after
wrapper capability changes with:

```sh
pnpm --filter @reddb-io/rsp gen:ambient-skill
```

## Recovery Model

When `rsp` omits bytes, it prints an `el:<id>` handle. Handles are short,
content-addressed identifiers minted by `RspElisionStore.mint(original, meta)`.
The resident writes handle records into the rsp-owned RedDB KV collection and
chooses one of three storage classes:

- **derivable**: git blob-backed output such as `git diff`, `git log`, `git show`,
  `git blame`, and file reads that can be reconstructed from stored object ids.
- **re-executable**: deterministic repository commands such as `git status` and
  `git branch -av` whose command recipe and content hash are enough to replay or
  detect moved state.
- **ephemeral**: outputs that must keep bytes, stored as gzip-compressed
  content-hash blobs so identical outputs share one physical blob.

Each handle records the command, loss level, creation time, expiry time, raw byte
count, storage class, and stored byte cost. The accounting lane is the handle
index: it totals stored bytes, raw bytes, and per-class records so `rsp stats`
can report both recoverability and physical pressure. The default 64 MiB
physical cap applies to stored recipe/blob bytes, not raw command-output bytes.
Expired or evicted handles retain a tombstone with the original command to rerun.

Recover a handle with:

```sh
rsp show el:<id>
```

Defaults are seven days of derivable/re-executable elision retention, six hours
of ephemeral retention, and a 64 MiB physical cap; `.red/config.yaml` can
override `rsp.ttlDays`, `rsp.ephemeralTtlHours`, and `rsp.byteBudget`.

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
  proxy:
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
