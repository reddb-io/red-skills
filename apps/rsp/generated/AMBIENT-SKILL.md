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
| `gh pr list` | `rsp gh pr list` |
| `gh pr view` | `rsp gh pr view` |
| `gh issue list` | `rsp gh issue list` |
| `gh issue view` | `rsp gh issue view` |
| `gh run list` | `rsp gh run list` |
| `gh run view` | `rsp gh run view` |
| `vitest` | `rsp vitest` |
| `vitest run` | `rsp vitest run` |
| `cargo test` | `rsp cargo test` |

## Recovering elided output

`rsp show el:<id>` writes the original bytes verbatim to stdout. Expired or
evicted handles print `expired <ISO date> — re-run: <original command>` and
exit 1, so the exact command to reproduce the output is always in reach.
