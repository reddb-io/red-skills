# Runner: Claude-MiniMax

How `/afk` invokes the Claude Code CLI against MiniMax's Anthropic-compatible endpoint as the inner agent for one issue (PRD #788).

`claude-minimax` reuses the **unchanged** `claude-code` Worker provider, but overrides two environment variables in the inner spawn so the Claude Code CLI talks to MiniMax instead of real Anthropic:

| variable | value |
|---|---|
| `ANTHROPIC_API_KEY` | resolved from `MINIMAX_API_KEY` in the orchestrator env |
| `ANTHROPIC_BASE_URL` | `https://api.minimax.io/anthropic` |

The model is fixed to `MiniMax-M3` regardless of the resolved AFK tier, because that is the only Claude-Code-compatible model MiniMax exposes on their Anthropic-compat endpoint at the time of the spike gate (#790).

## Selection — explicit pin only

`claude-minimax` is accepted **only as an explicit pin**:

- `--runner claude-minimax`, or
- `RED_AFK_RUNNER=claude-minimax`.

It is **never auto-sniffed** from the ambient environment. An absent or empty `MINIMAX_API_KEY` causes the inner spawn to produce an auth error that routes through the normal failure path.

## Spawn

The spawn command mirrors `claude-code` exactly — only the model id and the inner env block differ:

```bash
claude \
  --model MiniMax-M3 \
  --effort <resolved-effort> \
  --permission-mode bypassPermissions \
  --output-format stream-json \
  --verbose \
  --print "$full_prompt"
```

The Claude Code CLI reads `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL` from its own environment; AFK injects both via `minimax-env.ts`'s `resolveMiniMaxClaudeEnv` into the inner spawn env (never the orchestrator's own env).

## Effort capping

MiniMax-M3 does not accept thinking mode and only accepts thinking (`type: "adaptive"`) when explicitly enabled. To prevent spawn failures, the `claude-minimax` runner **caps effort to `low`**, which does not trigger thinking. Any higher requested effort (from `--effort` or the resolved tier) is degraded to `low` with a warning:

```
[afk] warn: effort '<requested>' triggers thinking which MiniMax-M3 does not accept; capping to 'low' for runner 'claude-minimax'
```

When no effort is requested, the lane passes `low` explicitly so the inner spawn never auto-selects a thinking tier.

## Exhaustion Detection

MiniMax's Anthropic-compat endpoint surfaces quota/rate-limit errors in two ways; the orchestrator's exhaustion matcher (`isRunnerExhausted` / `isExhaustionError`, `runner-spawn.ts`) detects both:

1. **Anthropic-format error body** — `{"type":"error","error":{"type":"rate_limit_error","message":"..."}}`. The `rate_limit_error` substring is in the exhaustion pattern.

2. **HTTP 429 status** — when the rate-limit signal reaches Claude Code as a bare HTTP status code string (`"API Error: 429 Too Many Requests"` or `"HTTP error: 429"`), the `\b429\b` term in the exhaustion pattern catches it.

On exhaustion the orchestrator emits the internal `RUNNER_EXHAUSTED` signal, labels the issue `blocked:quota`, and retries up to `RED_AFK_RETRY_QUOTA` times (default 3) before escalating to `ready-for-human`.

## Transient Failures

Network transport failures to `api.minimax.io` (connection refused, DNS lookup failure, connection reset, timeout) surface as Node.js POSIX error codes in the Claude Code CLI error output:

- `ECONNREFUSED` — MiniMax endpoint unreachable
- `ENOTFOUND` — DNS lookup failure
- `ETIMEDOUT` / `ECONNRESET` — connection timeout or reset

All four are in the `runnerTransientPattern` (`execution.ts`) and route to `runner-transient`, triggering bounded retry rather than a crash that orphans the issue in `running`.

## Working Directory

Claude is invoked with the sandcastle-created worktree as its cwd, identical to the regular `claude` runner. The handoff file lives one level above the worktree at `.red/tmp/workers/{id}/{N}-a{n}/handoff.md`.
