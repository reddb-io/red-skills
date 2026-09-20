# RedSkills

Skills, agent instructions and declarative marketplace definitions for Claude Code,
Codex, Gemini, Pi, OpenCode, RedCode and Hermes.

Runtime software lives in [reddb-io/redskilled](https://github.com/reddb-io/redskilled):
MCP servers, daemon, apps, tunnel, IDE integrations, hooks, installers and all
package publishing. Existing npm package names remain unchanged.

## Install

Install the exact runtime version declared in `runtime.toon` using Redskilled's
`scripts/install-runtime.sh <version>`, then register this marketplace in your host.
The `red-skills-*` commands must be on the host's PATH. Hooks and MCP declarations
invoke installed commands; they do not download software or execute repository scripts.

## Contribute

Edit `plugins/<plugin>/skills`, references, agent instructions or marketplace
metadata. This repository contains no executable implementation. Read
[CONTRIBUTING.md](CONTRIBUTING.md) for validation and coordinated changes.

The repositories have independent versions. `runtime.toon` pins the supported runtime;
Redskilled's `skills.lock.toon` pins the content revision used in its distribution.
Historical releases stay available here; new software releases are published by
Redskilled. See [the separation contract](.red/REPOSITORY-SPLIT.md).
