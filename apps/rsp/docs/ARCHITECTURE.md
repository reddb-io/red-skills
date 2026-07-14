# rsp Architecture

`rsp` has three jobs:

1. Replace noisy command output with compact, decision-preserving output.
2. Keep omitted bytes recoverable through `el:<id>` handles.
3. Record telemetry so RedSkills can measure savings, degradation, and warm
   resident behavior.

The implementation is intentionally fail-open: a broken reducer should not
block the command the operator asked to run.

## CLI and Wrappers

`apps/rsp/src/cli.ts` is the entry point. It parses the top-level command,
resolves `.red/config.yaml`, starts or contacts the resident when needed, and
dispatches to wrapper modules:

- `git-wrapper.ts` for git status, diff, log, show, blame, branch, commit, and
  push.
- `gh-wrapper.ts` for GitHub PR, issue, and workflow run list/view output.
- `test-wrapper.ts` for `vitest` and `cargo test`.
- `cat-wrapper.ts` for bounded file reads and code outlines.
- `exec-wrapper.ts` for arbitrary shell commands.
- `wait.ts` for standardized wait operations.

Each wrapper returns stdout, stderr, status, signal, and optional raw output
metadata. `emitWrappedResult()` writes the wrapper output first, then appends
telemetry best-effort.

## Permanent Proxy Routing

Pre-exec interception starts with the repository gate. If `.red/config.yaml`
does not set `rsp.enabled: true`, the hook records a `passed` decision with the
`disabled` reason and emits no updated command. When rsp is enabled but
`rsp.proxy.enabled` is absent or false, the hook uses the explicit capability
table plus conservative `cat`/`head`/`tail` and safe noisy compound matching.

When both `rsp.enabled: true` and `rsp.proxy.enabled: true` are set, the hook
uses the universal proxy route. Eligible commands are rewritten to
`rsp proxy -- '<original command>'` with capability `proxy:universal`, and the
hook decision event records reason `universal-proxy`. The hook still passes
through commands that would make routing unsafe or recursive:

- empty or missing commands: `missing-command`
- background jobs with a single `&`: `background`
- `RSP_NO_PROXY=1` or `RED_SKILLS_RSP_NO_PROXY=1`: `opt-out`
- commands whose first word is already `rsp`: `opt-out`
- known interactive commands such as shells, editors, pagers, `ssh`, `top`, and
  `htop`: `interactive`

`rsp proxy` executes the routed shell command verbatim after segment rewriting.
It splits shell segments on `&&`, `||`, `;`, and `|`, but it never rewrites a
segment whose next operator is a pipe. That keeps pipeline producer bytes raw.
For non-pipeline-tail segments, the proxy recognizes only families backed by
shipped wrappers:

- git `status`, `log`, `diff`, `show`, and `blame`
- GitHub `pr|issue|run list|view`
- `vitest` and `vitest run`
- `cargo test`
- simple `cat`, `head`, and `tail` file reads

Recognized segments emit decision telemetry with hook `proxy`, decision
`contributed`, reason `proxy-segment`, and a concrete capability id such as
`git:log` or `gh:pr:list`. GitHub commands containing `--json`, `--jq`,
`--json=...`, or `--jq=...` are the lossless selector family. The proxy records
them with decision `passed`, reason `lossless-gh-json-jq`, and leaves the exact
segment text unchanged.

If proxy routing fails after parsing the original command, `rsp proxy` appends a
`failed-open` decision with reason `proxy-internal-error` and runs the original
command line. If parsing fails before an original command is known, it surfaces
the usage error instead of inventing a command to run.

## Resident Lifecycle

The resident is started through `rsp server` or warmed by client calls through
`ensureResidentServer()` and `warmResidentServer()`. Runtime paths come from the
shared resident-client package and include a socket path, PID file, wake-lock
path, and PID registry under the repository's `.red/tmp` area.

The resident process:

- Listens on a local socket and accepts one JSON request per newline-framed
  connection.
- Opens the configured RedDB store once with `allowResidentOpen: true`.
- Acts as the single embedded writer for elision, telemetry stats, telemetry
  gains, memory, and brain requests.
- Writes a PID file and a PID registry entry containing the socket path,
  store URI, and resident version.
- Resets an idle timer on each accepted socket and request.
- Starts shutdown after the idle timeout, closes the server, destroys active
  sockets, performs a final telemetry drain, closes the store, removes the
  socket, removes the PID file, and removes the PID registry entry.
- Arms an idle shutdown watchdog so a stuck shutdown cannot leave the resident
  alive indefinitely.
- Cleans up child `red rpc --stdio` processes on exit and also runs a small
  parent-death guard on non-Windows platforms.

The version handover path is explicit. When a client asks for `handover`, the resident
returns the running resident version and the client version, then schedules its
own shutdown. A newer client can then start a fresh resident with the new code.

## Socket Protocol

The socket protocol is newline-delimited JSON. Requests carry an `id` and an
operation. Responses echo the `id`, include `ok: true` and a `value`, or
`ok: false` and an error string. Successful responses also include resident
metrics such as store-open count and store-open elapsed milliseconds; wrapper
telemetry records those metrics to distinguish cold boots from warm hits.

Supported resident operations include:

- `ping`
- `handover`
- `stats`
- `telemetry-stats`
- `telemetry-gains`
- `mint`
- `get`
- `memory`
- `brain`

## Elision Store and Handles

The default store URI points at the repo-local shared RedDB file. The elision
collection is `rsp_elisions_v1`, stored as a RedDB KV collection. The resident
keeps an `index:v1` document beside the records so pruning can enforce both
time-to-live and byte-budget limits.

Minting an elision:

1. Hashes the original bytes and metadata into a stable `el:<id>` handle.
2. Stores the original bytes as base64 with command metadata, loss level,
   creation time, expiry time, and byte count.
3. Deletes any old tombstone for the same handle.
4. Updates the index.
5. Prunes expired records and oldest records over the byte budget.
6. Verifies that the RedDB record and index entry were persisted.

Reading an elision returns the original bytes when live. If a record has
expired or has been evicted, `rsp` returns an expired tombstone with the expiry
time and original command. `rsp show el:<id>` writes live original bytes
verbatim and prints the expired tombstone message otherwise.

The store also retains a JSON-document fallback for non-RedDB URIs and legacy
migration code for older table-shaped elision collections, but the normal
repository path is the resident-backed RedDB KV store.

## Telemetry Chain

Wrappers do not write telemetry directly into RedDB. They append compact JSONL
events to `.red/tmp/rsp-telemetry.spool.jsonl`. Appending is best-effort and
swallows write errors so the user command remains authoritative.

The resident owns the drain:

1. `appendTelemetryEvent()` writes compact invocation events to the spool.
   Large raw/emitted text fields are replaced by byte counts before spooling.
2. `ResidentTelemetryDrain` periodically renames the spool to a process-local
   drain file.
3. Each line is parsed and written to a RedDB KV telemetry collection.
4. Bad lines or write failures become degradation events rather than blocking
   the drain.
5. The telemetry index is pruned by telemetry TTL and byte budget.
6. `writeStatusSummary()` writes `.red/tmp/rsp-status-summary.json` for the
   statusline summary.

Telemetry collections:

- `rsp_telemetry_invocations_v1`
- `rsp_telemetry_degradations_v1`
- `rsp_telemetry_index_v1`

The resident self-heals telemetry collections that exist with an incompatible
model when it can safely drop and recreate them. Collection model mismatches
are also recorded as degradation events.

## Stats, Gains, and Statusline Summary

`rsp` and `rsp stats` read elision-store stats plus a telemetry window. The
telemetry stats include invocation count, elision count, raw/emitted bytes,
estimated tokens saved, estimated dollar savings, top commands, degradation
rate, most recent degradation, latency percentiles, resident cold/warm metrics,
and decision-lane counts: `seen`, `contributed`, `passed`, `failed_open`,
`contribution_rate`, and top pass reasons. Those decision fields are the
evidence for hook and proxy contribution claims.

`rsp gains` reads a wider telemetry report designed for operational review. It
groups latency by command family, builds request throughput rows, reports a
weekday/hour heatmap, aggregates weekly token savings, lists top commands by
tokens saved and invocation count, identifies the biggest single elision, and
summarizes degradation history.

The statusline summary is a small JSON file with today's token and dollar
savings estimate plus an update timestamp. It lets shells and agents display a
cheap status without opening the store.

## Wait Registry

The wait registry is the repo-local record of active `rsp wait` processes.

`rsp wait` provides bounded waits for:

- `rsp wait cmd -- "<command>"`
- `rsp wait pr <number>`
- `rsp wait run <run-id>`
- `rsp wait run --branch <branch> --latest`
- `rsp wait release --tag "<glob>"`
- `rsp wait ls`

Every active wait writes a registry entry under `.red/tmp/waits/`. Entries
record the wait kind, target, reason, PID, started time, poll tier, timeout,
and current status. The process exit code is the signal:

- `0`: success verdict.
- `1`: failure verdict.
- `2`: timeout or indeterminate verdict.

The registry entry is updated while the wait runs and removed on every exit
path. `rsp wait ls` reads the registry, filters out dead PIDs, and reports the
live waits.

## Hook Interception

`rsp hook claude-pre-exec` reads a host hook payload and rewrites only simple,
known-safe command shapes to their `rsp` equivalents. It covers the generated
wrapper capabilities plus plain `cat`, `head`, and `tail` file reads. Compound
commands, environment assignment prefixes, unsupported commands, disabled
repositories, missing commands, or unhealthy residents pass through.

`rsp hook codex-pre-exec` uses the same decision engine and emits Codex
`updatedInput` when a rewrite is selected. Codex does not use post-exec output
replacement; accounting for Codex hook contribution comes from the decision
event and, for proxy-routed commands, the proxy segment decisions.

When the resident is unhealthy, the hook wakes it and returns passthrough for
that command. The next command can use the wrapper after the resident is ready.
`rsp hook claude-post-exec` is the normalization hook for host-provided command
output.

## Fail-Open Invariant

The invariant is simple: `rsp` may save tokens, but it must not make the user
lose the command result.

Important fail-open paths:

- Disabled repositories do not force wrapper behavior.
- Proxy-disabled repositories use the explicit wrapper route instead of the
  universal proxy route.
- Universal proxy exclusions pass through before command execution.
- Missing store provisioning lets wrapper commands run cold where possible.
- Wrapper exceptions call the raw command path through passthrough degradation.
- Proxy internal errors run the original command and record `failed-open`.
- `gh` auth/rate-limit and other fault outputs preserve the byte-level fault
  output.
- `gh --json`/`--jq` selector commands are recorded as `lossless-gh-json-jq`
  passes and execute byte-identically.
- Binary file reads pass through unchanged.
- Telemetry append, telemetry drain, status summary, and cold drain nudges are
  best-effort.
- `rsp exec` preserves stderr and exit status even when stdout is summarized.
- `rsp wait` returns explicit success/failure/timeout status instead of hiding
  indeterminate waits.

This is why wrapper code records raw output separately from emitted output and
why telemetry is written after stdout/stderr are already emitted.
