# 0162 — `/redskilled` setup selects a Machine role

- **Status**: accepted
- **Date**: 2026-08-23
- **Related**: ADR 0158 (Remote-link process boundary); ADR 0160 (`/redskilled` owns Host setup); ADR 0161 (self-hosted Link relay)
- **Source**: `/start` grilling session of 2026-08-23, maintainer rounds Q27–Q28

## Context

The operator wants one obvious setup entry across desktops, old notebooks, Raspberry Pis, and a publicly reachable relay machine. Those machines do not all need the same runtime: a compute Host needs `redskilled` and a Host-side Remote link, a relay-only machine must not carry an idle execution daemon, and one small deployment may intentionally combine both roles. Requiring unrelated installers would expose the internal package split during onboarding; installing everything everywhere would waste resources and blur the process boundaries from ADR 0158.

## Decision

`/redskilled` is the unified interactive setup entry and begins by requiring one **Machine role**:

- **Host** installs and configures `redskilled` plus its Host-side `redskilled-link` companion.
- **Relay** installs and configures only the publicly reachable `redskilled-link relay`; it does not install `redskilled`.
- **Host + Relay** configures both isolated runtimes on the same machine.

The selection controls provisioning only. It does not merge process ownership, state, credentials, or failure domains: `redskilled` remains the Host control plane, the Host-side Remote link remains its authenticated companion, and the Link relay remains transport infrastructure. Setup is idempotent and may be rerun to inspect or change the selected role without clobbering unrelated operator state.

## Considered options

- Keep `/redskilled` Host-only and require a separate `redskilled-link setup`. Rejected because the operator should choose what the machine does before needing to know the artifact layout.
- Install Host + Relay on every machine. Rejected because most Hosts are behind NAT and need no listening relay, while a relay-only VPS needs no Worker runtime or GitHub credential profile.
