# rsp Architecture

`rsp` has three jobs:

1. Replace noisy command output with compact, decision-preserving output.
2. Keep omitted bytes recoverable through `el:<id>` handles.
3. Record telemetry so RedSkills can measure savings, degradation, and warm
   resident behavior.

The implementation is intentionally fail-open: a broken reducer should not
block the command the operator asked to run.

## CLI and Wrappers

`apps/rsp/src/entry.ts` is the installed entry point. The release bundle uses
the equivalent `bundle-entry.ts`: a small, independently parsed launcher beside
`rsp-core.bundle.min.mjs`. `fast-boundary.ts` executes unknown simple commands
with their original argv before configuration, telemetry, store, or resident
modules load. Shell compounds that contain no modeled segment execute through
their original shell string on the same fast path. `completed-boundary.ts`
captures only the completed agent-facing streams; nonempty UTF-8 stdout lazily
loads the core's `structured-boundary.ts`, while empty and binary stdout never
pay that parser cost.

The structured boundary sniffs JSON, YAML, TOON, and TOONL, emits canonical
TOON only when decode/encode/decode preserves the original data model, and
otherwise returns the original Buffer. Pipeline stages stay inside the native
shell execution and therefore never cross this boundary; only final stdout may
transform. Stderr, exit status, and termination signal are never transformed.

Modeled and RSP-owned commands load `core-entry.ts`, whose `main()` parses the
top-level command, resolves `.red/config.yaml`, contacts the resident only when
shared state is needed, and dispatches to wrapper modules:

- `git-wrapper.ts` for git status, diff, log, show, blame, branch, commit, and
  push.
- `gh-wrapper.ts` for GitHub PR, issue, and workflow run list/view output.
- `test-wrapper.ts` for `vitest` and `cargo test`.
- `cat-wrapper.ts` for bounded file reads and code outlines.
- `exec-wrapper.ts` for arbitrary shell commands.
- `wait/` for standardized wait operations.

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
segment whose next operator is a pipe. That keeps pipeline producer bytes raw;
the completed structured boundary runs only after the entire shell exits.
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
segment text and its internal protocol bytes unchanged. Once the shell exits,
its final stdout follows the same lossless structured-data boundary as every
other proxied command.

Redirections stay owned by the shell. A safely modeled segment keeps its raw
redirect suffix when rsp prefixes the specialized executor; grouping, command
substitution, malformed syntax, and other ambiguous shapes keep the original
shell execution path. Native `&&` and `||` therefore retain their exact
short-circuit behavior even in mixed modeled/unmodeled compounds.

If proxy routing fails after parsing the original command, `rsp proxy` appends a
`failed-open` decision with reason `proxy-internal-error` and runs the original
command line. If parsing fails before an original command is known, it surfaces
the usage error instead of inventing a command to run.

## Resident Lifecycle

The resident is the lazy control plane for shared state, not a prerequisite for
the synchronous command data plane. Universal argv execution starts no resident,
opens no store, and writes no telemetry or state file. Commands that transform,
recover, coordinate, or account for output load the core and contact the
resident as described below.

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
- Is the only *running* opener of the store (ADR 0126). Every other surface —
  the pre-exec hook and proxy, the CLI wrappers, `show`/`gains`/`stats`, the
  bare dashboard, `wait` capture, and the MCP tool handlers — reaches it through
  `residentElisionStore()` in `resident-store.ts`. The store module keeps one
  further opener, `provisionElisionStore()`, for the `rsp setup` moment when no
  resident can exist yet because the file itself does not.
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
- `recovery-handles`
- `accounting-stats`
- `telemetry-stats`
- `telemetry-gains`
- `mint`
- `get`
- `memory`
- `brain`

## Elision Store and Handles

The default store URI points at the repo-local shared RedDB file. The elision
collection is `rsp_elisions_v1`, stored as a RedDB KV collection. The resident
keeps an `index:v1` accounting lane beside the records so pruning can enforce
both time-to-live and the physical cap.

Minting an elision:

1. Hashes the original bytes and metadata into a stable `el:<id>` handle.
2. Classifies the handle into one of three storage classes:
   - `derivable` for output that can be reconstructed from stored git blob
     object ids, such as file reads and git diff/log/show/blame output.
   - `re-executable` for deterministic repository commands, currently `git
     status` and supported `git branch` forms, where the command recipe and
     content hash are enough to replay or detect moved state.
   - `ephemeral` for output that must retain bytes directly.
3. Stores recipe metadata for derivable and re-executable handles, or stores
   ephemeral bytes as gzip-compressed content-hash blobs. Identical ephemeral
   outputs share one physical blob.
4. Records command metadata, loss level, creation time, expiry time, raw byte
   count, stored byte cost, and storage class.
5. Deletes any old tombstone for the same handle.
6. Updates the index.
7. Prunes expired records and oldest records over the physical cap.
8. Verifies that the RedDB record and index entry were persisted.

The accounting lane is the `index:v1` document. Each live handle contributes
its storage class, raw bytes, and stored bytes; shared blobs are counted once.
`rsp stats` exposes this as a per-class breakdown plus the total stored bytes
and configured budget. The default cap is 64 MiB of physical recipe/blob storage,
not 64 MiB of original command-output bytes.

Reading an elision returns the original bytes when live. If a record has
expired or has been evicted, `rsp` returns an expired tombstone with the expiry
time and original command. `rsp show el:<id>` writes live original bytes
verbatim and prints the expired tombstone message otherwise. If a derivable or
re-executable recipe can no longer reconstruct the original bytes, the handle
degrades to the same expired-handle contract instead of pretending recovery is
lossless.

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
6. `writeStatusSummary()` writes `.red/state/rsp/rsp-status-summary.toon` for the
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

The implementation is the `src/wait/` module. Each concern owns one file:
`paths` resolves repo identity, `registry` owns the live-wait records,
`lifecycle` runs the deadline and cancellation, `github`/`probes` observe
GitHub, `capture` bounds command output, and `completion`/`delivery` seal the
result and wake the sleeper. `index` owns only the sequence.

### Repo identity

`paths` is the single authority for where a wait's state lives. It walks up for
a `.red`, but stops at the repository boundary so an unrelated ancestor `.red`
cannot capture the registry. A linked git worktree resolves through its `.git`
FILE (`gitdir: <main>/.git/worktrees/<name>`) back to the MAIN worktree, so a
wait started in a worktree and a `rsp wait ls` run from the main checkout share
one registry rather than growing two.

### Registry

Every active wait atomically writes a TOON registry entry under
`.red/tmp/waits/`. The `rsp.wait.registry` v1 schema records kind, target,
reason, PID and PID start time, started time, deadline, timeout, poll tier,
attempt count, last poll, last observation, and current status. Writes land by
rename, so a concurrent reader sees the old record or the new one and never a
partial one. `rsp wait ls` also reads legacy JSON entries, rejects reused PIDs
through start-time validation, treats a corrupted record as stale rather than
fatal, and removes what it rejects.

### Completion transaction

Every completion emits a versioned `rsp.wait.result` v1 envelope, as TOON by
default or JSON with `--json`.

Completion is monotonic and has three states. The verdict is SEALED to disk
first, with `delivery.status: pending`; then hooks run; then the receipt is
stamped `success` or `failure`. Because the durable record is never written as
provisionally successful, a process awakened by `--signal-pid` or `--notify-cmd`
always observes a complete, stable target verdict and an honest delivery state.
`--result-file <path>` persists that envelope by atomic rename before any wake.

The envelope keeps `target_exit_code` separate from the final `exit_code`, so a
successful target followed by a delivery failure is never reported as a target
failure or as an ambiguous green. The process exit code is the coordination
semaphore:

- `0`: success verdict.
- `1`: failure verdict.
- `2`: timeout, indeterminate, or unresolved delivery.

`--signal-pid` is validated when the wait starts and its PID start time is
pinned. The identity is re-checked immediately before the signal fires, so a PID
recycled during a long wait produces a delivery failure instead of a signal
delivered to an unrelated process.

### Bounded capture

For `cmd`, stdout and stderr are captured with a fixed memory ceiling: at most
`--capture-bytes` stays resident as the inline head, and everything past it
streams to a spool file before being handed to the elision store through a
store-adapter seam. Elided output always carries an `el:<id>` handle for
byte-exact recovery; if the store is unavailable the spool file is KEPT and its
path reported, so store loss costs recoverability but never bytes. A head that
is not printable text is emitted as labeled base64, so binary output survives
the envelope intact.

### Cancellation and cleanup

Timeout, SIGINT, and SIGTERM terminate the detached command process group with
TERM, wait the grace period, re-enumerate descendants, then use KILL, and finally
VERIFY that the pids are gone. A wait that cannot prove cleanup reports exit 2
rather than an ambiguous success. Notify hooks receive the stable result through
`RSP_WAIT_RESULT_JSON`, `RSP_WAIT_RESULT_FILE`, `RSP_WAIT_STATUS`,
`RSP_WAIT_EXIT_CODE`, `RSP_WAIT_TARGET`, and `RSP_WAIT_RESULT_SCHEMA`;
`--notify-timeout` bounds hook delivery and reports failures explicitly.

### GitHub bounds

Each GitHub probe is bounded by `--probe-timeout` (default 60s) in addition to
the wait's own cancellation signal. Supported PR, run, job, and release reads
use `@reddb-io/github` conditional requests, not a spawned `gh` polling loop.
The resident owns that client when available. When rsp is disabled or the
resident cannot start, the already-long-lived wait owns one in-process client
for its lifetime, preserving ETags, adaptive rate-limit balance snapshots, and
attribution without repeatedly retrying the unavailable resident.

GitHub polling preserves its last observation on timeout or interruption. REST
`mergeable_state: dirty` is normalized to the GraphQL `CONFLICTING` vocabulary,
so a conflicting PR is a failure even when checks pass. `run --branch <branch>
--latest` resolves once and pins that run ID before polling, so a newer run
cannot silently change the target. Registry entries are removed on every exit
path after the result has been persisted.

JSON appears in this scope only at external boundaries — GitHub payloads, the
explicit `--json` presentation option, and the `RSP_WAIT_RESULT_JSON` hook
variable. All RedSkills-owned state is TOON.

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

## Overhead Budget

`rsp` measures both sides of its own ledger (#2746). Savings alone cannot tell
an operator whether rsp is paying for itself, so every invocation also records
the wall clock rsp added on top of the wrapped command (`overhead_ms`, total
minus the child process's own runtime) and the bytes it read from its own state
(`self_state_bytes_read` — ETag caches, telemetry spools, ledgers).

A sample breaches the ceiling when it adds more than `rsp.overhead.maxOverheadMs`
of wall clock, reads more than `rsp.overhead.maxSelfStateBytes` of self-state, or
reads more of its own state than it removed from the agent's context. After
`rsp.overhead.consecutiveBreaches` consecutive breaches the wrapper family
self-disables for `rsp.overhead.cooldownMs`: its commands run raw, the reason is
written to `.red/state/rsp/overhead-budget.toon`, and the family re-arms once the
cooldown lapses.

The verdict is the surface, not a log line. `rsp status` renders `verdict: green`
or `verdict: red` with the breaching families and the reason, `rsp stats` and the
bare dashboard carry the same block, and `rsp doctor` fails its `overhead_budget`
probe while a ceiling is breached.

Self-disabling is a fail-open, never a failure: stdout and stderr are forwarded
byte for byte and the exit status is the raw command's own.

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
  passes and retain native bytes until the final agent boundary.
- Binary file reads pass through unchanged.
- Invalid, ambiguous, prose, binary, or failed structured-data proofs return
  the original stdout bytes while preserving stderr and command status.
- An unreachable resident socket costs the elision, never the command: wrappers
  and the proxy hand back the raw stdout, stderr, and exit status, `stats` and
  the bare dashboard degrade to the empty snapshot, `wait` keeps its spooled
  bytes rather than claiming a handle nothing can recover, and the MCP tools
  return the payload they were handed.
- Telemetry append, telemetry drain, status summary, and cold drain nudges are
  best-effort.
- A wrapper family self-disabled by the overhead budget runs the raw command and
  preserves its stdout, stderr, and exit status exactly.
- `rsp exec` preserves stderr and exit status even when stdout is summarized.
- `rsp wait` returns explicit success/failure/timeout status instead of hiding
  indeterminate waits.

This is why wrapper code records raw output separately from emitted output and
why telemetry is written after stdout/stderr are already emitted.
