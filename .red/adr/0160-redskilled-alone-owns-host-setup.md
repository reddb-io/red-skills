# 0160 — `/redskilled` alone owns Host setup

- **Status**: accepted
- **Date**: 2026-08-23
- **Related**: ADR 0067 (repository plugin activation); ADR 0130 (`redskilled` host singleton and daemon home); ADR 0150 (always-on daemon installation)
- **Source**: `/start` grilling session of 2026-08-23, maintainer rounds Q23–Q24

## Context

RedSkills has two setup authorities with different lifetimes. `/red-setup` owns activation and policy stored in one repository's `.red/`; `/redskilled` owns the daemon home, service, credentials, ceilings, lifecycle, and other operator policy shared by every Project on one machine. The texts stated that distinction but crossed it operationally: `/red-setup` Section E3 invoked daemon provisioning, ADR 0150 allowed either skill to install the service, and `/red-doctor` routed a failed host-provisioning audit back to `/red-setup`. That made a repository operation an implicit writer of machine state and left two interactive entry points responsible for one Host.

## Decision

`/redskilled` is the sole interactive owner of **Host setup**. It installs and configures the daemon, its OS service, host ceilings, GitHub credential profiles, lifecycle, and Remote-link participation through daemon-owned commands. `/red-setup` owns only **Repository setup**. When the `dev` plugin requires a daemon, `/red-setup` performs a read-only preflight; if Host setup is absent or unhealthy, it stops and tells the operator to run `/redskilled`. It never provisions, repairs, restarts, or configures `redskilled`, even after confirmation. `/red-doctor` remains read-only and routes every Host-setup finding to `/redskilled`.

This amends only ADR 0150 decision 4: the daemon remains an always-on OS service and clients still fail closed instead of spawning it, but `/red-setup` is removed as an installer.

## Considered options

- Let `/red-setup` ask permission and delegate automatically to `/redskilled`. Rejected because the repository workflow would still hide a machine-scoped mutation and blur which setup the operator is performing.
- Let `/red-setup` ignore daemon health. Rejected because a repository could appear ready and then fail at first execution without an actionable preflight.
