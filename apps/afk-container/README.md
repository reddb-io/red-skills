# afk-container — AFK-in-a-box

A self-sufficient Docker image that drains `ready-for-agent` issues from GitHub
repositories, one ephemeral run at a time, through the **existing AFK engine**.

The container reimplements nothing. It picks a runner, picks the queue head, clones
the target repo into a temp directory, and hands the issue to
`npx -y -p @reddb-io/red-skills-dev@<version> red-skills-dev run --issues <N> --runner <R> --once`
— the same engine path the local fleet and the Actions lane drive. Claim comment, heartbeat, validation gate
and pull request all come from that engine.

## Stateless by construction

No volume, no daemon, no cache to preserve. All durable state is on GitHub:

- the issue — its labels and its claim / heartbeat / park comments;
- the run branch the engine pushes, and the pull request it opens.

The clone lives in a temp directory and is deleted when the run ends, on any path.
**Kill the container at any moment** — mid-clone, mid-agent, mid-gate — and the issue
stays reclaimable: the claim comment goes stale and the engine's existing stale-claim
reconciliation hands it back to the queue. There is nothing to clean up by hand.

## Build

```bash
docker build -t afk-in-a-box \
  --build-arg RED_SKILLS_VERSION=2.23.1 \
  apps/afk-container
```

Build args (all default to `latest`, which is a convenience, not a contract — pin
them for anything you run repeatedly):

| Build arg              | Pins                             |
| ---------------------- | -------------------------------- |
| `RED_SKILLS_VERSION`   | `@reddb-io/red-skills` (the engine) |
| `CLAUDE_CODE_VERSION`  | `@anthropic-ai/claude-code`       |
| `CODEX_VERSION`        | `@openai/codex`                   |
| `OPENCODE_VERSION`     | `opencode-ai`                     |
| `NODE_VERSION`         | the `node:<v>-bookworm-slim` base |
| `PNPM_VERSION`         | the corepack-activated pnpm       |

## Run

One issue, then exit:

```bash
docker run --rm \
  -e GH_TOKEN \
  -e ANTHROPIC_API_KEY \
  -e RED_AFK_TARGET_REPOS=reddb-io/red-skills \
  afk-in-a-box
```

Keep draining, sleeping when the queue empties:

```bash
docker run --rm \
  -e GH_TOKEN -e ANTHROPIC_API_KEY -e OPENAI_API_KEY -e OPENROUTER_API_KEY \
  -e RED_AFK_TARGET_REPOS=owner/one,owner/two \
  -e RED_AFK_RUNNER_CADENCE=claude,codex,opencode \
  -e RED_AFK_LOOP=true \
  afk-in-a-box
```

Exit codes: `0` when a run finishes or the queue is empty; the engine's own exit code
when a run fails; `2` on a bad configuration or when no cadence runner is credentialed.

## Environment

| Variable                     | Required | Default                  | Meaning                                                                   |
| ---------------------------- | -------- | ------------------------ | ------------------------------------------------------------------------- |
| `GH_TOKEN` / `GITHUB_TOKEN`  | yes      | —                        | Reads the queue, posts the claim trail, pushes the branch, opens the PR.   |
| `RED_AFK_TARGET_REPOS`       | yes      | —                        | One `owner/name` slug, or a comma-separated list. Rotated per run.         |
| `RED_AFK_RUNNER_CADENCE`     | no       | `claude,codex,opencode`  | Round-robin order, one step per run. See the cadence section below.        |
| `RED_AFK_LOOP`               | no       | `false`                  | `true` repeats forever; an empty queue sleeps instead of exiting.          |
| `RED_AFK_LOOP_IDLE_SECONDS`  | no       | `60`                     | First idle sleep; doubles per consecutive empty queue.                     |
| `RED_AFK_LOOP_MAX_IDLE_SECONDS` | no    | `900`                    | Ceiling for that backoff.                                                  |
| `RED_AFK_QUEUE_LABEL`        | no       | `ready-for-agent`        | The queue label to drain.                                                  |
| `RED_AFK_MODEL`              | no       | repo config              | Model override for every tier. Passed straight through to the engine.      |
| `RED_AFK_EFFORT`             | no       | repo config              | Reasoning-effort override (still provider-gated).                          |
| `RED_AFK_WORK_ROOT`          | no       | `/home/afk/work`         | Where the ephemeral clone is made.                                         |
| `GIT_AUTHOR_NAME`            | no       | `afk-container[bot]`     | Committer identity for the run branch.                                     |
| `GIT_AUTHOR_EMAIL`           | no       | `afk-container@users.noreply.github.com` | Committer email.                                           |

`RED_AFK_SANDBOX` is forced to `none` — the container *is* the sandbox, so a target
repo configured for docker/podman never nests another one. `RED_AFK_LANE=container`
tags the run for observability.

### Runner credentials

A runner without a credential is skipped, and the cadence falls through to the next
one. Any single non-blank value credentials the runner:

| Runner           | Credential env (engine precedence)                       |
| ---------------- | -------------------------------------------------------- |
| `claude`         | `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN`        |
| `codex`          | `OPENAI_API_KEY`                                          |
| `opencode`       | `OPENAI_API_KEY` > `MINIMAX_API_KEY` > `OPENROUTER_API_KEY` |
| `claude-minimax` | `MINIMAX_API_KEY`                                         |

If no cadence entry is credentialed, the container exits `2` without touching the
queue — it never claims an issue it cannot work.

## Cadence

The cadence rotates by one per run: run 0 uses the first entry, run 1 the second, and
so on. When the selected runner has no credential, selection walks forward through the
cadence (wrapping once) to the first one that does. Fallback stays **inside** the
cadence, so a runner you never listed can never be reached.

### The claude-minimax evaluation lane

`claude-minimax` is never in the default cadence. MiniMax-M3 does not reliably emit the
DONE sentinel, so it is an evaluation lane, entered only when you name it explicitly:

```bash
docker run --rm \
  -e GH_TOKEN -e MINIMAX_API_KEY \
  -e RED_AFK_TARGET_REPOS=owner/name \
  -e RED_AFK_RUNNER_CADENCE=claude-minimax \
  -e RED_AFK_MODEL=MiniMax-M3 \
  afk-in-a-box
```

`RED_AFK_MODEL` is passed through untouched — the same contract as the Actions lane's
`model:` input. Leave it unset and the target repo's `.red/config.yaml` stays in charge.

## Target repo requirements

The target repo needs whatever its own AFK validation gate needs (for a pnpm workspace:
a lockfile the image's pnpm can install). Submodules are cloned recursively, and SSH
submodule URLs are rewritten to token-authenticated HTTPS, because the image carries no
SSH key.

## Not in scope

No Kubernetes or Helm, no org-level listening, no stateful internal daemon, and no
changes to the Actions lane (`rs-afk-attempt.yml`) — that lane keeps working exactly as
before. This image is the third way to run one AFK attempt, next to the local fleet and
GitHub Actions.
