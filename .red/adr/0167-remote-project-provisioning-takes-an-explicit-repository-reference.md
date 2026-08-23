# 0167 — Remote Project provisioning takes an explicit repository reference

- **Status**: accepted
- **Date**: 2026-08-23
- **Related**: ADR 0144 (daemon-owned Project workspace); ADR 0152 (daemon-owned stores and credentials); ADR 0164 (second mobile slice); ADR 0166 (bounded Mobile operator)
- **Source**: `/start` grilling session of 2026-08-23, maintainer rounds Q38–Q39

## Context

Provisioning repositories from the mobile app could require a GitHub repository catalog with search, pagination, organization and installation filtering, cache freshness, and another read surface before the core control loop needs any of them. Authenticating GitHub in the app would duplicate the daemon's credential authority and move durable secrets across the remote boundary. The operator already knows which repository they intend to add.

## Decision

**Remote Project provisioning** accepts an explicit GitHub `owner/repo` spelling or repository URL and provides no repository browser in V1. The mobile app sends that reference and no GitHub credential to the selected Host. `redskilled` validates the input, authenticates through a daemon-owned named GitHub credential profile, resolves GitHub's stable repository identity, creates or reuses the canonical daemon-owned Project workspace, and registers the Project idempotently.

The typed repository reference is only a lookup input and never becomes the Project's immutable key or a client-selected filesystem path. Repeating the operation after a rename or from another spelling resolves to the same Project rather than creating a second clone. Access, clone, and registration failures are returned as typed Host results; the Link relay performs none of them.

## Considered options

- Browse every repository accessible to a selected credential profile. Rejected for V1 because it adds a catalog product and remote API surface without improving the known-repository workflow.
- Authenticate GitHub in the mobile app and delegate its token. Rejected because credentials and shared API budgeting belong exclusively to redskilled's GitHub gateway.
