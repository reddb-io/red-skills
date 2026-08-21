# worker-container — AFK-in-a-box

A self-sufficient Docker image that drains `ready-for-agent` issues from GitHub
repositories by **becoming a RedSkills host**.

The container reimplements nothing, and — since #4118 — it no longer loops over
the queue itself. ADR 0150 §4 makes the `redskilled` daemon the only thing that
births a Worker, and a client that finds no daemon fails closed rather than
spawning one. So the entrypoint supervises a daemon of its own, clones each
target repository once as that project's workspace, registers the project
through the daemon's Project control surface, and then just follows the drain.
Which issue is next, when a Worker is born, what it is briefed with, the
validation gate, the branch and the pull request all come from `@reddb-io/worker`
under that daemon (ADR 0148) — the same Worker body every other lane runs.

## The shape this lane took

Two shapes were defensible for #4118. This is the first one: **the container is
a host, and the queue loop is the daemon's demand loop.** The alternative — one
Worker per container invocation — would have kept a queue reader in the
entrypoint, and a second reader of one queue is exactly how a container exits
while a Worker it birthed is still running. Registering instead puts the width
(`RED_AFK_TARGET`), the admission decision and the reclaim in the one place that
already owns them.

Concretely:

1. `serve` starts as this process's one long-lived child. There is no init
   system in a container, so the entrypoint is the supervisor.
2. Each `RED_AFK_TARGET_REPOS` entry is cloned once into a temp directory. That
   clone is the project workspace the daemon materialises Worker worktrees from.
3. One ACP session per clone registers the project: an opaque tracker query, a
   typed poll plan, the birth argv, the trunk and the Worker prompt. The daemon
   carries all of it and reads none of it (ADR 0130 rule 3).
4. The entrypoint polls Project status until every queue is drained, then stops
   the daemon and deletes the clones.

## Stateless by construction

No volume, no cache to preserve. All durable state is on GitHub:

- the issue — its labels and its claim / heartbeat / park comments;
- the branch a Worker pushes, and the pull request the daemon lands.

The clones live in temp directories and are deleted when the run ends, on any
path. **Kill the container at any moment** and the issue stays reclaimable: the
claim goes stale and the reclaim on the next host that drains the queue hands it
back. There is nothing to clean up by hand.

## Build

```bash
docker build -t afk-in-a-box \
  --build-arg RED_SKILLS_VERSION=4.1.15 \
  apps/worker-container
```

Build args (all default to `latest`, which is a convenience, not a contract — pin
them for anything you run repeatedly):

| Build arg              | Pins                              |
| ---------------------- | --------------------------------- |
| `RED_SKILLS_VERSION`   | `@reddb-io/red-skills` (the daemon) |
| `CLAUDE_CODE_VERSION`  | `@anthropic-ai/claude-code`        |
| `CODEX_VERSION`        | `@openai/codex`                    |
| `OPENCODE_VERSION`     | `opencode-ai`                      |
| `NODE_VERSION`         | the `node:<v>-bookworm-slim` base  |
| `PNPM_VERSION`         | the corepack-activated pnpm        |

## Run

Drain until the queue empties, then exit:

```bash
docker run --rm \
  -e GH_TOKEN \
  -e ANTHROPIC_API_KEY \
  -e RED_AFK_TARGET_REPOS=reddb-io/red-skills \
  afk-in-a-box
```

Keep the registration standing and keep draining, sleeping when the queue empties:

```bash
docker run --rm \
  -e GH_TOKEN -e ANTHROPIC_API_KEY -e OPENAI_API_KEY -e OPENROUTER_API_KEY \
  -e RED_AFK_TARGET_REPOS=owner/one,owner/two \
  -e RED_AFK_RUNNER_CADENCE=claude,codex,opencode \
  -e RED_AFK_TARGET=2 \
  -e RED_AFK_LOOP=true \
  afk-in-a-box
```

Exit codes: `0` when every registered queue drains (or when loop mode is asked to
stop); `1` when a registration lapses so nothing polls its queue, or when the
daemon cannot be reached; `2` on a bad configuration or when no cadence runner is
credentialed.

## Environment

| Variable                     | Required | Default                  | Meaning                                                                   |
| ---------------------------- | -------- | ------------------------ | ------------------------------------------------------------------------- |
| `GH_TOKEN` / `GITHUB_TOKEN`  | yes      | —                        | Reads the queue, posts the claim trail, pushes the branch, opens the PR.   |
| `RED_AFK_TARGET_REPOS`       | yes      | —                        | One `owner/name` slug, or a comma-separated list. Each becomes a Project.  |
| `RED_AFK_RUNNER_CADENCE`     | no       | `claude,codex,opencode`  | Candidate coder Agents; the first credentialed one is named in the birth argv. |
| `RED_AFK_TARGET`             | no       | `1`                      | Drain width asked for. The host still decides how many Workers it grants.  |
| `RED_AFK_LOOP`               | no       | `false`                  | `true` keeps following the drain; an empty queue sleeps instead of exiting. |
| `RED_AFK_LOOP_IDLE_SECONDS`  | no       | `60`                     | First idle sleep; doubles per consecutive empty queue.                     |
| `RED_AFK_LOOP_MAX_IDLE_SECONDS` | no    | `900`                    | Ceiling for that backoff.                                                  |
| `RED_AFK_POLL_SECONDS`       | no       | `15`                     | How often the container asks the daemon where the drain stands.            |
| `RED_AFK_QUEUE_LABEL`        | no       | `ready-for-agent`        | The label that defines "queued".                                           |
| `RED_AFK_QUEUE_LANE`         | no       | —                        | Narrows the query to one `lane:<value>`.                                   |
| `RED_AFK_WORK_ROOT`          | no       | `/home/afk/work`         | Where the project clones are made.                                         |
| `RED_SKILLS_VERSION`         | no       | the build arg            | The version every invocation of the daemon binary is pinned to.            |
| `RED_SKILLS_INVOCATION`      | no       | `path` in this image     | `path` uses the globally installed binary; anything else uses the canonical `npx -y -p @reddb-io/red-skills@<version>` form (ADR 0091). |
| `GIT_AUTHOR_NAME`            | no       | `afk-container[bot]`     | Committer identity for the branch.                                         |
| `GIT_AUTHOR_EMAIL`           | no       | `afk-container@users.noreply.github.com` | Committer email.                                           |

The container carries no sandbox knob: the container **is** the sandbox. Inside
an unprivileged container no cgroup driver is reachable, so the daemon's
placement degrades to an unisolated native spawn and reports that it did —
which is the honest answer for a process whose isolation is already the
container around it. `RED_AFK_LANE=container` tags the run for observability.

### Runner credentials

A runner without a credential is skipped, and the cadence falls through to the next
one. Any single non-blank value credentials the runner:

| Runner           | Credential env (precedence)                               |
| ---------------- | --------------------------------------------------------- |
| `claude`         | `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN`         |
| `codex`          | `OPENAI_API_KEY`                                           |
| `opencode`       | `OPENAI_API_KEY` > `MINIMAX_API_KEY` > `OPENROUTER_API_KEY` |
| `claude-minimax` | `MINIMAX_API_KEY`                                          |

If no cadence entry is credentialed, the container exits `2` without touching the
queue — it never registers work it cannot run.

### The claude-minimax evaluation lane

`claude-minimax` is never in the default cadence. MiniMax-M3 does not reliably emit
the DONE sentinel, so it is an evaluation lane, entered only when you name it:

```bash
docker run --rm \
  -e GH_TOKEN -e MINIMAX_API_KEY \
  -e RED_AFK_TARGET_REPOS=owner/name \
  -e RED_AFK_RUNNER_CADENCE=claude-minimax \
  afk-in-a-box
```

## Target repo requirements

The target repo needs whatever its own validation gate needs (for a pnpm workspace:
a lockfile the image's pnpm can install). Submodules are cloned recursively, and SSH
submodule URLs are rewritten to token-authenticated HTTPS, because the image carries no
SSH key.

## Not in scope

No Kubernetes or Helm, no org-level listening, and no changes to the Actions lane
— that lane keeps working exactly as before. This image is the third way to run
RedSkills Workers, next to an operator's own host daemon and GitHub Actions.
