# AFK-in-a-box — a self-sufficient image that drains `ready-for-agent` issues from
# GitHub repos through the existing AFK engine, one ephemeral run at a time.
#
# The image carries no repo source: it installs the published `@reddb-io/red-skills`
# npm package (ADR 0091) and calls its `red-skills-dev` bin, so the claim protocol,
# heartbeat, validation gate and pull request all come from the same engine the
# local fleet and the Actions lane use. Pin the engine with
# `--build-arg RED_SKILLS_VERSION=<semver>`; `latest` is a convenience, not a contract.
#
#   docker build -t afk-in-a-box --build-arg RED_SKILLS_VERSION=2.23.1 apps/afk-container
#
# Stateless by construction: no VOLUME, no daemon, no cache to preserve. Every run
# clones into a temp dir and deletes it. See README.md for the env/secret table.

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim

# Renovate/dependabot-friendly pins. `latest` keeps a first-run cheap; production
# deployments should pass exact versions for every one of these.
ARG RED_SKILLS_VERSION=latest
ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest
ARG OPENCODE_VERSION=latest
ARG PNPM_VERSION=11.5.0

LABEL org.opencontainers.image.title="afk-in-a-box" \
      org.opencontainers.image.description="Self-sufficient AFK worker: drains ready-for-agent issues via the red-skills engine." \
      org.opencontainers.image.source="https://github.com/reddb-io/red-skills" \
      org.opencontainers.image.licenses="Apache-2.0"

ENV DEBIAN_FRONTEND=noninteractive

# git + gh drive the repo and the issue tracker; jq/ripgrep/curl are what agent
# runners reach for constantly. ca-certificates is required for every HTTPS call.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git gnupg jq less openssh-client procps ripgrep \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

# Target repos run their own validation gate; most of ours are pnpm workspaces.
RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate

# The three runners the cadence rotates through, plus the engine itself.
# claude-minimax reuses the claude-code CLI, so it needs no extra install.
RUN npm install -g --no-fund --no-audit \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
      "opencode-ai@${OPENCODE_VERSION}" \
      "@reddb-io/red-skills@${RED_SKILLS_VERSION}" \
 && npm cache clean --force

# The claude CLI refuses `--dangerously-skip-permissions` as root, and the engine
# always passes it on this lane — so the run must not be root.
RUN useradd --create-home --shell /bin/bash afk

COPY --chown=afk:afk src/ /opt/afk/src/

USER afk
WORKDIR /home/afk

# Ephemeral clones land here. Nothing survives the container; no VOLUME on purpose.
ENV RED_AFK_WORK_ROOT=/home/afk/work
RUN mkdir -p /home/afk/work

ENTRYPOINT ["node", "/opt/afk/src/entrypoint.mjs"]
