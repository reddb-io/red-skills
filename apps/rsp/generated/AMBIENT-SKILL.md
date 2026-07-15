# rsp — token-efficient command wrappers

<!-- GENERATED FILE — do not edit by hand.
     Source: apps/rsp/src/intercept.ts (RSP_WRAPPER_CAPABILITIES),
     rendered by apps/rsp/src/ambient-skill.ts.
     Regenerate: pnpm --filter @reddb-io/rsp gen:ambient-skill -->

`rsp` wraps noisy development commands and stores their full output in a
reversible elision store, so the agent reads a compact summary and can
recover the original bytes on demand with `rsp show el:<id>`.

## Permanent Proxy Model

When `.red/config.yaml` sets `rsp.enabled: true` and `rsp.proxy.enabled: true`,
the pre-exec hook routes eligible shell commands through `rsp proxy -- <command>`
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
`lossless-gh-json-jq` passes and execute byte-identically.

Decision telemetry is the truth source for proxy coverage. A `contributed`
decision means rsp inserted a wrapper; `passed` means it deliberately left the
command or segment raw; `failed-open` means rsp ran the original command after
an internal proxy failure. Read `rsp stats` contribution metrics as measured
routing evidence, not a promise that every command family was compressed.

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
- For `vitest`, prefer `rsp vitest` when the summarized output is enough.
- For `vitest run`, prefer `rsp vitest run` when the summarized output is enough.
- For `cargo test`, prefer `rsp cargo test` when the summarized output is enough.

For arbitrary shell pipelines or compound commands where only final stdout
should enter the agent context, call `rsp exec -- "<command line>"` directly.
Bytes inside pipes remain untouched; stderr and exit status follow the raw
shell command.

Use raw commands when exact stdout/stderr is the behavior under test, when
a wrapper does not support the command shape, or when resolving low-level
git conflicts where every byte matters.

## Standardized Waiting

Never hand-write sleep polling loops; run `rsp wait` in a background shell - process exit IS the signal.

Examples:

- `rsp wait pr 123 --reason "before merge"` waits for a GitHub PR's checks and reports pass/fail plus mergeable state.
- `rsp wait run 987654321` waits for a GitHub Actions run conclusion.
- `rsp wait run --branch feature/wait --latest` waits for the latest run on a branch.
- `rsp wait release --tag "v2.*"` waits for the next matching release to publish.
- `rsp wait cmd -- "pnpm -C apps/rsp build"` runs a local async command and waits for its exit.
- `rsp wait ls` lists active waits from `.red/tmp/waits/`.

Exit codes: `0` = success verdict, `1` = failure verdict, `2` = timeout/indeterminate.
Every wait writes a live registry entry under `.red/tmp/waits/` with its target, reason, pid, started time, poll tier, and status, then removes that entry on every exit path.

## Loss levels

Use `--brief` for compact summaries that keep enough inline context for
normal debugging. Use `--terse` for large or repetitive output; lossy output
mints an `el:<id>` handle, and `rsp show el:<id>` writes the original bytes
back to stdout. Use `--full` when exact inline output is required.

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
