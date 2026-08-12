# rsp — token-efficient command wrappers

<!-- GENERATED FILE — do not edit by hand.
     Source: apps/rsp/src/intercept.ts (RSP_WRAPPER_CAPABILITIES),
     rendered by apps/rsp/src/ambient-skill.ts.
     Regenerate: pnpm --filter @reddb-io/rsp gen:ambient-skill -->

`rsp` wraps noisy development commands and stores their full output in a
reversible elision store, so the agent reads a compact summary and can
recover the original bytes on demand with `rsp show el:<id>`.
Bare `rsp` renders a live TOON dashboard with recovery handles, active waits, today's savings snapshot, and degradation health instead of usage text.
Use `--help` after any subcommand for scoped flags, defaults, and examples.
Outputs may include `next_steps` templates with placeholders when a useful next action is not obvious.

<supporting-info>
Troubleshooting recipes for hook silence, resident/store splits, and store growth live in `apps/rsp/docs/TROUBLESHOOTING.md`.
</supporting-info>

## Core model

The command boundary is the synchronous data plane. Unknown simple argv launches
before configuration, telemetry, store, or resident code loads. After completion,
JSON, YAML, TOON, or TOONL stdout becomes canonical TOON only when an immediate
decode/encode/decode proof preserves its data model; every other byte passes through.
Large repetitive structured rows cross pinned size and repetition thresholds into
a deterministic TOON summary. The summary declares every cap or sort, includes
aggregates and next steps, and exposes exactly one handle only after the resident
has stored the original bytes. `rsp show` reproduces those bytes exactly.
The resident is the lazy control plane and sole owner of shared
elision and telemetry state under `.red/state/rsp`; specialized wrappers, the
CLI, hooks, proxy, and MCP clients contact it only when shared state is needed.
No surface is a privileged or canonical contact point. A host with no MCP
server connected is fully supported — summaries, `el:<id>` handles, and
recovery all work in headless and cron lanes.

## Permanent Proxy Model

When `.red/config.yaml` sets `rsp.enabled: true`, proxy routing is on by
default (an explicit `rsp.proxy.enabled: false` is the opt-out) and the
pre-exec hook routes eligible shell commands through `rsp proxy -- <command>`
instead of matching only a top-level allowlist. The hook still passes through
missing commands, background jobs, recursive `rsp` calls, known interactive
commands, and commands opted out with `RSP_NO_PROXY=1` or
`RED_SKILLS_RSP_NO_PROXY=1`.

`rsp proxy` executes the shell command and only contributes where it recognizes
a stdout-tail segment it can wrap. Recognized segment families are git
`status|log|diff|show|blame`, GitHub `pr|issue|run list|view`, `vitest`,
`vitest run`, `cargo test`, and simple `cat`/`head`/`tail` file reads.
Pipeline producers are left raw, so bytes inside pipes remain untouched.
`gh ... --json` and `gh ... --jq` selections are recorded as
`lossless-gh-json-jq` passes and keep native bytes until the final agent boundary.
A plain `gh api <REST-path>` GET is routed to `rsp gh api`, which shares the
resident rate-aware client and emits canonical TOON; API writes and explicit
caller-owned `--jq`/template byte contracts remain untouched.

Decision telemetry is the truth source for proxy coverage. A `contributed`
decision means rsp inserted a wrapper; `passed` means it deliberately left the
command or segment raw; `failed-open` means rsp ran the original command after
an internal proxy failure. Read `rsp stats` contribution metrics as measured
routing evidence, not a promise that every command family was compressed.
Unknown simple commands preserve argv, stderr, exit status, and termination signal.
Ordinary passthrough creates no rsp state; only a qualifying lossy summary lazily
mints recovery state. Pipeline stages receive native bytes; only completed final
stdout may cross the lossless structured-data boundary.

## Wrapped commands

When you would run one of these commands, run it through `rsp` instead:

| Command | rsp wrapper |
| --- | --- |
| `cat <file>` | `rsp cat <file>` |
| `head <file>` / `head -n N <file>` | `rsp cat --head N <file>` |
| `tail <file>` / `tail -n N <file>` | `rsp cat --tail N <file>` |
| `git status` | `rsp git status` |
| `git log` | `rsp git log` |
| `git diff` | `rsp git diff` |
| `git commit` | `rsp git commit` |
| `git push` | `rsp git push` |
| `git blame` | `rsp git blame` |
| `git branch -av` | `rsp git branch -av` |
| `git show` | `rsp git show` |
| `gh pr list` | `rsp gh pr list` |
| `gh pr view` | `rsp gh pr view` |
| `gh issue list` | `rsp gh issue list` |
| `gh issue view` | `rsp gh issue view` |
| `gh run list` | `rsp gh run list` |
| `gh run view` | `rsp gh run view` |
| `gh issues` | `rsp gh issues` |
| `gh prs` | `rsp gh prs` |
| `gh edit-labels` | `rsp gh edit-labels` |
| `gh link-sub-issues` | `rsp gh link-sub-issues` |
| `vitest` | `rsp vitest` |
| `vitest run` | `rsp vitest run` |
| `cargo test` | `rsp cargo test` |

## When to prefer rsp

- For deterministic file reads, prefer `rsp cat <file>`; code files render an outline plus bounded content, text/config files are threshold-gated, and binary files pass through untouched.
- For simple file dumps, the host pre-exec hook may rewrite bare `cat <file>`, `head <file>`, `head -n N <file>`, `tail <file>`, and `tail -n N <file>` when the path is an unquoted single file token.
- For `git status`, prefer `rsp git status` when the summarized output is enough.
- For `git log`, prefer `rsp git log` when the summarized output is enough.
- For `git diff`, prefer `rsp git diff` when the summarized output is enough.
- For `git commit`, prefer `rsp git commit` when the summarized output is enough.
- For `git push`, prefer `rsp git push` when the summarized output is enough.
- For `git blame`, prefer `rsp git blame` when the summarized output is enough.
- For `git branch -av`, prefer `rsp git branch -av` when the summarized output is enough.
- For `git show`, prefer `rsp git show` when the summarized output is enough.
- For `gh pr list`, prefer `rsp gh pr list` when the summarized output is enough.
- For `gh pr view`, prefer `rsp gh pr view` when the summarized output is enough.
- For `gh issue list`, prefer `rsp gh issue list` when the summarized output is enough.
- For `gh issue view`, prefer `rsp gh issue view` when the summarized output is enough.
- For `gh run list`, prefer `rsp gh run list` when the summarized output is enough.
- For `gh run view`, prefer `rsp gh run view` when the summarized output is enough.
- For `gh issues`, prefer `rsp gh issues` when the summarized output is enough.
- For `gh prs`, prefer `rsp gh prs` when the summarized output is enough.
- For `gh edit-labels`, prefer `rsp gh edit-labels` when the summarized output is enough.
- For `gh link-sub-issues`, prefer `rsp gh link-sub-issues` when the summarized output is enough.
- For `vitest`, prefer `rsp vitest` when the summarized output is enough.
- For `vitest run`, prefer `rsp vitest run` when the summarized output is enough.
- For `cargo test`, prefer `rsp cargo test` when the summarized output is enough.

For an unlisted simple command, call `rsp <command> <args...>`; rsp preserves
the argv exactly and stays off the resident and state paths. For shell syntax
such as redirects, pipelines, and compounds, call `rsp proxy -- "<command
line>"`; unsupported shapes execute through the original shell. When only
final stdout should enter the agent context, call `rsp exec -- "<command line>"`.
Bytes inside pipes remain untouched; stderr and exit status follow the raw
shell command. Invalid, ambiguous, prose, binary, or failed-proof stdout remains
byte-identical passthrough.

Use the argv passthrough or explicit proxy path when exact command behavior
is the contract under test. Resolve low-level git conflicts with raw git when
every byte of interactive intent belongs to the operator.

## Standardized Waiting

Never hand-write sleep polling loops; run `rsp wait` in a background shell - process exit IS the signal.

Examples:

- `rsp wait pr 123 --reason "before merge"` waits for a GitHub PR's checks and reports pass/fail plus mergeable state.
- `rsp wait run 987654321` waits for a GitHub Actions run conclusion.
- `rsp wait job 93919316178` waits for one GitHub Actions job through the conditional packages/github client.
- `rsp wait run --branch feature/wait --latest` waits for the latest run on a branch.
- `rsp wait release --tag "v2.*"` waits for the next matching release; `--existing --tag v2.3.4` uses the single-release endpoint for an already-published exact tag.
- `rsp wait cmd -- "pnpm -C apps/rsp build"` runs a local async command and waits for its exit.
- `rsp wait ls` lists active waits from `.red/tmp/waits/`.

Exit codes: `0` = success verdict, `1` = failure verdict, `2` = timeout/indeterminate.
Every wait emits an `rsp.wait.result` v1 envelope as TOON by default or JSON with `--json`; `--result-file <path>` persists it atomically before signaling another process.
The verdict is sealed to disk with `delivery: pending` BEFORE any wake, so a signaled process always reads a complete, stable result; the receipt is stamped afterwards and never downgrades a provisional success.
The envelope separates `target_exit_code` from delivery failure. `--signal-pid` validates the PID and pins its start time, so a recycled PID fails delivery instead of signaling a stranger; `--notify-cmd` receives stable `RSP_WAIT_*` context and is bounded by `--notify-timeout`.
Command stdout/stderr capture holds at most `--capture-bytes` in memory and spools the rest; elided streams carry reversible `el:<id>` handles, binary heads are labeled base64, and an unavailable store keeps the spooled bytes instead of truncating.
Timeout or interruption sends TERM to the whole process group, waits a grace period, then sends KILL, and VERIFIES the pids are gone; a wait that cannot prove cleanup exits 2 rather than reporting success.
`--probe-timeout` (default 60s) bounds one GitHub probe, so a hung `gh` call cannot outlive `--timeout`.
Never poll `gh api` or `gh run watch` in a sleep loop: the interception hook collapses recognized run, job, and release loops into `rsp wait`, whose packages/github client shares ETags, quota accounting, backoff, and TOON results.
When rsp is disabled or its resident is unavailable, a long-lived wait owns one in-process packages/github client for its whole lifetime; it never falls back to raw gh polling and does not retry a resident known to be unavailable.
Every wait writes an atomic v1 live registry entry under `.red/tmp/waits/` with kind, target, reason, PID/start time, deadline, attempts, last observation, last poll, poll tier, and status, then removes it on every exit path.
Linked git worktrees share the main checkout's registry, so a wait started in a worktree is visible to `rsp wait ls` anywhere in the repo.
GitHub waits retain their last observation; conflicting PRs fail, and `run --branch <branch> --latest` pins the resolved run ID before polling.

## Loss levels

Use `--brief` for compact summaries that keep enough inline context for
normal debugging. Use `--terse` for large or repetitive output; lossy output
mints an `el:<id>` handle, and `rsp show el:<id>` writes the original bytes
back to stdout. Use `--full` when exact inline output is required.
For an unlisted command, spell universal controls before `--`, for example
`rsp --brief -- <command> <args...>`, `rsp --terse -- <command> <args...>`, or
`rsp --full -- <command> <args...>`.

`rsp cat <file>`, large `rsp git diff`, and large `rsp git log` output may
truncate by default; pass `--full` when exact inline output is required.

## Recovering elided output

`rsp show el:<id>` writes the original bytes verbatim to stdout. Expired or
evicted handles print `expired <ISO date> — re-run: <original command>` and
exit 1, so the exact command to reproduce the output is always in reach.
Ephemeral byte payloads are stored as short-TTL compressed content blobs;
identical outputs share one stored blob without changing handle recovery.

## Failure behavior

If an rsp wrapper is disabled, lacks its store, or fails, it passes through to the raw command
with the raw command's stdout, stderr, and exit status intact.
An unreachable resident costs the elision, never the command: every surface
hands back the raw stdout, stderr, and exit status, `stats` and the bare
dashboard degrade to the empty snapshot, and `wait` keeps its spooled bytes
rather than minting a handle nothing can recover.
