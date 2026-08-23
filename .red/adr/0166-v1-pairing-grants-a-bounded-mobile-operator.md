# 0166 — V1 pairing grants a bounded Mobile operator

- **Status**: accepted
- **Date**: 2026-08-23
- **Related**: ADR 0144 (capability-scoped clients); ADR 0145 (ACP fabric); ADR 0158 (Remote link projects explicit operations); ADR 0163 (per-Host pairing)
- **Source**: `/start` grilling session of 2026-08-23, maintainer rounds Q36–Q37

## Context

The first product serves one operator controlling their own machines, so per-Project role composition would add onboarding and policy machinery before there is a second human to distinguish. Granting raw host administration would be worse: a paired phone must not become a shell, filesystem browser, credential exporter, machine-policy editor, or transparent ACP socket merely because the app needs to operate every Project on the Host.

## Decision

Every V1 Host pairing grants one **Mobile operator** capability bundle. It may list the Host's Projects, Tickets, and Workers; create Tickets; provision Projects through daemon-owned repository operations; and dispatch, observe, and stop Workers. It may not execute a shell, address arbitrary files, read or receive daemon-local GitHub credentials, mutate machine policy, forward raw ACP, or invoke a newly-added daemon method by default.

The Host-side Remote link authenticates the paired device and enforces an explicit allowlist of versioned application operations before projecting them onto local ACP. The mobile UI is not an enforcement boundary, and the Link relay receives no authorization role. Adding a remote operation requires extending the declared Mobile-operator capability and its compatibility contract; daemon capability discovery alone never widens an existing pairing.

## Considered options

- Choose Projects and granular permissions for each invitation. Deferred until multi-user operation creates a real second role; adding it now would burden the single-operator path without reducing the paired phone's intended Project reach.
- Make pairing read-only and require physical confirmation for every mutation. Rejected because remote dispatch and Worker control are the product's purpose.
- Forward the local ACP surface wholesale. Rejected because local reach is not remote authentication and future daemon methods would silently expand every phone's authority.
