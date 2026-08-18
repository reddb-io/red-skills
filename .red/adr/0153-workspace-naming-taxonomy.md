# 0153 — Workspace naming taxonomy: kind-prefixed apps, bare plugin names

- **Status**: accepted
- **Date**: 2026-08-18
- **Related**: ADR 0034/0060 (definitions/implementation split, Turborepo layout), ADR 0146 (one package per plugin), ADR 0148 (`packages/worker`, `packages/protocol-acp`)
- **Sources**: the `/start` grilling session of 2026-08-18

## Context

`apps/` mixed runtimes named for a plugin (`dev`, `memory`, `brain`), for a
capability (`code-nav`, `red-browser`), for a host (`opencode-host`,
`vscode-extension-red-skills`, `herdr-plugin-red-skills`,
`zellij-plugin-dashboard`), for a Worker image (`afk-container`) and for
benchmarks. A reader could not tell kind from name, and the plugins that may not
survive the execution-chain redesign still needed a name that says what they are.

## Decision

**`apps/<kind>-<name>`; `plugins/<name>` stays bare.** Renames: `dev` →
`plugin-dev`, `memory` → `plugin-memory`, `brain` → `plugin-brain`,
`code-nav` → `mcp-navigator`, `red-browser` → `mcp-browser`, `afk-container` →
`worker-container`, `zellij-plugin-dashboard` → `zellij-plugin-redskilled`,
`vscode-extension-red-skills` → `vscode-extension-redskilled`,
`herdr-plugin-red-skills` → `herdr-plugin-redskilled`, `opencode-host` →
`host-opencode`; `redskilled`, `rsp`, `release` keep their names. Benchmarks
leave `apps/` for `benchmarks/<name>`. `packages/red-castle` → `packages/worker`;
the shared wire is `packages/protocol-acp`. The `plugins/{dev,memory,brain,internal}`
directories keep bare names because they are what a host installs and what the
marketplace manifests call the plugin.

## Considered options

- Prefix `plugins/` too. Rejected: it changes what a user installs for no
  runtime gain, and the host already namespaces by plugin.
