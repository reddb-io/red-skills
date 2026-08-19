# `cwd` option and `promptFile` path resolution

## Context

The host repo directory was hardcoded to `process.cwd()` in `run()`, `interactive()`, `createSandbox()`, and `createWorktree()`. Callers orchestrating multiple repos from a single Node process had no way to target a different repo without `chdir`-ing the whole process.

A `cwd` option addresses this, but raises a question: when a user passes `cwd: "/other/repo"` along with `promptFile: "./prompt.md"`, where is the prompt read from?

## Decision

Add `cwd?: string` to all four programmatic entry points. Relative paths resolve against `process.cwd()`; absolute pass through. Default is `process.cwd()`. The CLI does not get `--cwd` — users `cd` first.

`promptFile` is **not** re-rooted under `cwd`. It is resolved as an ordinary Node file path, against `process.cwd()`. Only host-repo-derived paths (`.red-castle/worktrees/`, `.red-castle/.env`, `.red-castle/logs/`, `.red-castle/patches/`) follow `cwd`.

The rejected alternative was to resolve relative `promptFile` against `cwd`, so `"./.red-castle/prompt.md"` would always mean "the prompt inside the sandcastle project." That reads natural in examples, but it makes `promptFile` behave unlike every other file path a user passes to a Node API — surprising when debugging.

## Consequences

- Users supplying a custom `cwd` must pass an absolute `promptFile` (or arrange `process.cwd()` accordingly). Documented in the option's JSDoc.
- `_test.hostRepoDir` is removed from `createSandbox` and `createWorktree`; tests migrate to the public `cwd`. `_test.buildSandboxLayer` stays.
- The "tail -f" log hint prints an absolute path when `cwd !== process.cwd()`, relative otherwise.
