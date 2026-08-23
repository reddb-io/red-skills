# 0158 — Remote control is a companion, not a daemon listener

- **Status**: accepted
- **Date**: 2026-08-23
- **Related**: ADR 0130 (`redskilled` host singleton and frozen local wire); ADR 0144 (`redskilled` host control plane); ADR 0145 (ACP agent fabric)
- **Source**: `/start` grilling session of 2026-08-23, maintainer rounds Q08–Q09

## Context

Remote control needs pairing, device identity, revocation, network transport, and a versioned client protocol. Putting those concerns inside `redskilled` would make the process that admits, budgets, and re-attaches every Worker also carry an Internet-facing lifecycle; exposing either local socket would be worse, because the existing session reach is a blast-radius guard between local clients rather than a remote authentication boundary.

## Decision

Remote access belongs to a separate **Remote link** shipped as `apps/redskilled-link`. It authenticates paired devices, owns the remote connection, and projects only explicit capability-scoped operations onto the local ACP endpoint. `redskilled` remains reachable only through its Unix socket or Windows Named Pipe and owns every Project and Worker fact; the Remote link owns none of them and never births a Worker itself. `apps/redskilled-mobile` is only a remote client and neither receives daemon-local GitHub credentials nor addresses a local socket directly.

## Considered options

- Bind remote transport inside `apps/redskilled`. Rejected because a network, pairing, and revocation failure would enter the lifecycle authority for every Worker on the Host.
- Ship a Host executable from `apps/redskilled-mobile`. Rejected because one workspace would then mix React Native and Host runtimes and obscure which artifact carries remote authority.
