# rsp — token-efficient command wrappers

<!-- GENERATED FILE — do not edit by hand.
     Source: apps/rsp/src/intercept.ts (RSP_WRAPPER_CAPABILITIES),
     rendered by apps/rsp/src/ambient-skill.ts.
     Regenerate: pnpm --filter @reddb-io/rsp gen:ambient-skill -->

`rsp` wraps noisy development commands and stores their full output in a
reversible elision store, so the agent reads a compact summary and can
recover the original bytes on demand with `rsp show el:<id>`.

## Wrapped commands

When you would run one of these commands, run it through `rsp` instead:

| Command | rsp wrapper |
| --- | --- |
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

## Loss levels

Use `--brief` for compact summaries that keep enough inline context for
normal debugging. Use `--terse` for large or repetitive output; lossy output
mints an `el:<id>` handle, and `rsp show el:<id>` writes the original bytes
back to stdout. Use `--full` when exact inline output is required.

Large `rsp git diff` and `rsp git log` output is threshold-gated and may
truncate by default; pass `--full` when exact inline output is required.

## Recovering elided output

`rsp show el:<id>` writes the original bytes verbatim to stdout. Expired or
evicted handles print `expired <ISO date> — re-run: <original command>` and
exit 1, so the exact command to reproduce the output is always in reach.

## Failure behavior

If an rsp wrapper is disabled, lacks its store, or fails, it passes through to the raw command
with the raw command's stdout, stderr, and exit status intact.
