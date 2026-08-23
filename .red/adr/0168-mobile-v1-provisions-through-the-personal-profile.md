# 0168 — Mobile V1 provisions through the `personal` profile

- **Status**: accepted
- **Date**: 2026-08-23
- **Related**: ADR 0132 (daemon-owned GitHub budget); ADR 0144 (Project credential binding); ADR 0167 (explicit remote repository reference)
- **Source**: `/start` grilling session of 2026-08-23, maintainer rounds Q40–Q41

## Context

A Host may declare several daemon-owned GitHub credential profiles for personal identities and GitHub App installations. Exposing that set remotely would require profile discovery, selection, permission-sensitive error design, and UI for a capability the first single-operator slice does not need. Trying profiles until one succeeds would make Project identity and rate-budget ownership depend on hidden ordering.

## Decision

Mobile V1 **Remote Project provisioning** always uses the daemon-local compatibility profile named `personal`. The app neither lists profile names nor sends a profile selector, and the daemon never tries alternate profiles after an authorization failure. If `personal` is absent, invalid, rate-limited beyond the operation, or cannot access the submitted repository, provisioning fails with a typed Host result and no Project is registered.

This restriction applies only to the mobile provisioning surface. `redskilled` continues to support multiple named profiles for local clients and already-registered Projects, and a Project remains durably bound to its chosen profile. A later protocol version may add explicit named-profile selection without moving credentials onto the phone or changing existing bindings.

## Considered options

- Return non-secret profile names and ask the operator when several exist. Deferred because it expands setup and wire shape before the V1 operator requires organization identity selection.
- Try configured profiles in priority order. Rejected because successful access would silently choose the Project's credential identity and rate-budget domain.
